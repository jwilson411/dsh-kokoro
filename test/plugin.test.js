/**
 * The plugin surface: what `apply` registers, what the tool promises, and what
 * it returns when driven through the same `execute` the registry calls.
 *
 * Nothing here boots a profile, opens a socket, or loads a model. The tool is
 * built with an injected `fetch` double answering with bytes this file made
 * up, and with its own throwaway output directory; the global `fetch` is a
 * guard that throws, so a path that reached for a real Kokoro server would
 * fail as a test failure rather than a live request.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_BASE_URL,
  DEFAULT_SPEED,
  DEFAULT_VOICE,
  KOKORO_TTS_TOOL_NAME,
  MAX_SPEED,
  MAX_TEXT_CHARS,
  MIN_SPEED,
  PLUGIN_NAME,
  VOICE_NAMES,
  apply,
  createKokoroTtsTool,
  inject,
  isWavBytes,
  name,
  resolveConfig,
  silentWav,
} from '../src/index.js'
import { execContext, networkGuard, stubContext, tempOutputDir, wavFetch } from './helpers.js'

const guard = networkGuard()

const exec = execContext()

/** A wav the fake server "renders", distinguishable by its length. */
const WAV = silentWav({ seconds: 0.05 })

/**
 * Build the tool wired to a fake server and a throwaway output directory.
 * @param t - The test context, which owns the directory's cleanup.
 * @param overrides - Extra factory options, e.g. a different `fetch`.
 * @returns The tool, the `fetch` double, and the directory it writes into.
 */
function ttsTool(t, overrides = {}) {
  const outputDir = tempOutputDir(t)
  const fetchImpl = overrides.fetch ?? wavFetch(WAV)
  const tool = createKokoroTtsTool({
    baseURL: 'http://127.0.0.1:8765',
    outputDir,
    env: {},
    ...overrides,
    fetch: fetchImpl,
  })
  return { tool, fetchImpl, outputDir }
}

test('apply registers exactly one tool, named kokoro_tts', () => {
  const { ctx, registered } = stubContext()

  apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, KOKORO_TTS_TOOL_NAME)
  assert.equal(KOKORO_TTS_TOOL_NAME, 'kokoro_tts')
})

test('the plugin declares its cordis name and its one hard dependency', () => {
  assert.deepEqual(inject, ['tools'])
  assert.equal(name, 'kokoro')
  assert.equal(PLUGIN_NAME, 'dsh-kokoro')
})

test('the tool declares text as required and voice and speed as optional', () => {
  const { ctx, registered } = stubContext()
  apply(ctx)
  const [tool] = registered

  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 0)
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['text'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['speed', 'text', 'voice'])
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.voice.type, 'string')
  assert.equal(tool.parameters.properties.speed.type, 'number')
})

test('the tool offers the model no way to choose a path', (t) => {
  const { tool } = ttsTool(t)
  const properties = Object.keys(tool.parameters.properties)

  for (const forbidden of ['path', 'output', 'output_path', 'file', 'filename', 'dir', 'outputDir']) {
    assert.ok(!properties.includes(forbidden), `${forbidden} must not be a tool argument`)
  }
  assert.ok(!/\b(path|filename|output)\b:/.test(JSON.stringify(tool.parameters.properties)))
})

test('the base URL comes from the patch row first, then the env, then the default', () => {
  assert.equal(resolveConfig({}, {}).baseURL, DEFAULT_BASE_URL)
  assert.equal(DEFAULT_BASE_URL, 'http://127.0.0.1:8000')

  const fromEnv = resolveConfig({}, { DSH_KOKORO_BASE_URL: 'http://127.0.0.1:8765' })
  assert.equal(fromEnv.baseURL, 'http://127.0.0.1:8765')

  const fromRow = resolveConfig(
    { baseURL: 'http://kokoro.lan:9000/' },
    { DSH_KOKORO_BASE_URL: 'http://127.0.0.1:8765' },
  )
  assert.equal(fromRow.baseURL, 'http://kokoro.lan:9000')

  // A blank environment variable is not a choice, so the default still wins.
  assert.equal(resolveConfig({}, { DSH_KOKORO_BASE_URL: '  ' }).baseURL, DEFAULT_BASE_URL)
})

test('config bounds fall back to the defaults when the patch row sets none', () => {
  const defaults = resolveConfig({}, {})

  assert.ok(defaults.timeoutMs > 0)
  assert.ok(defaults.maxBytes > 0)
  assert.ok(defaults.outputDir.includes('dsh-kokoro'))

  const set = resolveConfig({ timeoutMs: 500, maxBytes: 1024 }, {})
  assert.equal(set.timeoutMs, 500)
  assert.equal(set.maxBytes, 1024)
})

test('a rejected base URL fails at config time rather than on the first utterance', () => {
  for (const bad of ['file:///etc/passwd', 'data:audio/wav;base64,AAAA', 'not a url', '']) {
    assert.throws(
      () => resolveConfig({ baseURL: bad }, {}),
      (error) => {
        assert.equal(error.code, 'KOKORO_BAD_BASE_URL')
        return true
      },
      `expected KOKORO_BAD_BASE_URL for ${JSON.stringify(bad)}`,
    )
  }

  // A row that names the key but leaves it blank is a misconfiguration, not a
  // request for the default — the default is what an absent key means.
  for (const blank of ['', '   ']) {
    assert.throws(
      () => resolveConfig({ baseURL: blank }, { DSH_KOKORO_BASE_URL: 'http://elsewhere:1234' }),
      (error) => {
        assert.equal(error.code, 'KOKORO_BAD_BASE_URL')
        return true
      },
      `expected KOKORO_BAD_BASE_URL for ${JSON.stringify(blank)}`,
    )
  }
})

test('a call posts to {baseURL}/tts and writes the wav under the plugin output dir', async (t) => {
  const { tool, fetchImpl, outputDir } = ttsTool(t)

  const value = await tool.execute({ text: 'Hello there.' }, exec)

  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, KOKORO_TTS_TOOL_NAME), [])
  assert.equal(value.voice, DEFAULT_VOICE)
  assert.equal(value.speed, DEFAULT_SPEED)
  assert.equal(value.text_chars, 'Hello there.'.length)
  assert.equal(value.bytes, WAV.byteLength)
  assert.equal(value.plugin, PLUGIN_NAME)

  // The path is the plugin's to choose: inside its directory, and a wav.
  assert.ok(value.path.startsWith(`${outputDir}/`), value.path)
  assert.match(value.path, /\/kokoro-am_michael-[0-9a-f-]{36}\.wav$/)
  assert.deepEqual(readdirSync(outputDir), [value.path.slice(outputDir.length + 1)])

  // What was written is byte-for-byte what the server sent.
  const written = readFileSync(value.path)
  assert.equal(written.byteLength, WAV.byteLength)
  assert.ok(isWavBytes(new Uint8Array(written)))

  assert.equal(fetchImpl.calls.length, 1)
  const [call] = fetchImpl.calls
  assert.equal(call.url, 'http://127.0.0.1:8765/tts')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.redirect, 'manual')
  assert.match(call.init.headers['user-agent'], /^dsh-kokoro\/\d+\.\d+\.\d+ \(\+https:\/\//)
  assert.deepEqual(JSON.parse(call.init.body), {
    text: 'Hello there.',
    voice: DEFAULT_VOICE,
    speed: DEFAULT_SPEED,
  })
})

test('the voice and speed the caller names are the ones sent and reported', async (t) => {
  const { tool, fetchImpl } = ttsTool(t)

  const value = await tool.execute({ text: 'Steady on.', voice: 'bf_emma', speed: 1.25 }, exec)

  assert.equal(value.voice, 'bf_emma')
  assert.equal(value.speed, 1.25)
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    text: 'Steady on.',
    voice: 'bf_emma',
    speed: 1.25,
  })
  assert.match(value.path, /kokoro-bf_emma-/)
})

test('every allowlisted voice is accepted, and the list matches the server', async (t) => {
  const { tool } = ttsTool(t)

  assert.equal(VOICE_NAMES.length, 19)
  assert.equal(VOICE_NAMES[0], DEFAULT_VOICE)
  assert.ok(VOICE_NAMES.includes('am_michael'))
  assert.ok(VOICE_NAMES.includes('bm_george'))
  assert.ok(VOICE_NAMES.includes('af_heart'))

  for (const voice of VOICE_NAMES) {
    const value = await tool.execute({ text: 'x', voice }, exec)
    assert.equal(value.voice, voice, `for ${voice}`)
  }
})

test('an unknown voice fails loudly, before the socket and before any file', async (t) => {
  const { tool, fetchImpl, outputDir } = ttsTool(t)

  for (const voice of ['am_michel', 'sk_hana', 'AM_MICHAEL', 'toString', '']) {
    await assert.rejects(
      () => tool.execute({ text: 'hello', voice }, exec),
      (error) => {
        assert.equal(error.code, 'KOKORO_BAD_VOICE')
        assert.match(error.message, /am_michael/)
        return true
      },
      `expected KOKORO_BAD_VOICE for ${JSON.stringify(voice)}`,
    )
  }

  assert.deepEqual(fetchImpl.calls, [])
  assert.deepEqual(readdirSync(outputDir), [])
})

test('blank and over-long text fail loudly, before the socket and before any file', async (t) => {
  const { tool, fetchImpl, outputDir } = ttsTool(t)

  for (const text of ['', '   ', '\n\t ', 'x'.repeat(MAX_TEXT_CHARS + 1)]) {
    await assert.rejects(
      () => tool.execute({ text }, exec),
      (error) => {
        assert.equal(error.code, 'KOKORO_BAD_TEXT')
        return true
      },
      `expected KOKORO_BAD_TEXT for ${text.length} characters`,
    )
  }

  // Exactly at the cap is fine: the bound is inclusive, as the server's is.
  const value = await tool.execute({ text: 'x'.repeat(MAX_TEXT_CHARS) }, exec)
  assert.equal(value.text_chars, MAX_TEXT_CHARS)

  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(readdirSync(outputDir).length, 1)
})

test('a speed outside 0.5–2.0 is refused rather than clamped', async (t) => {
  const { tool, fetchImpl, outputDir } = ttsTool(t)

  for (const speed of [0, 0.49, 2.01, 4, -1]) {
    await assert.rejects(
      () => tool.execute({ text: 'hello', speed }, exec),
      (error) => {
        assert.equal(error.code, 'KOKORO_BAD_SPEED')
        assert.match(error.message, /0\.5–2/)
        return true
      },
      `expected KOKORO_BAD_SPEED for ${speed}`,
    )
  }

  // NaN and Infinity are not JSON numbers, so the declared schema turns them
  // away first. Either way the call is refused before the socket.
  for (const speed of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => tool.execute({ text: 'hello', speed }, exec),
      ToolArgsError,
      `expected ToolArgsError for ${speed}`,
    )
  }

  for (const speed of [MIN_SPEED, 1, MAX_SPEED]) {
    const value = await tool.execute({ text: 'hello', speed }, exec)
    assert.equal(value.speed, speed)
  }

  assert.equal(fetchImpl.calls.length, 3)
  assert.equal(readdirSync(outputDir).length, 3)
})

test('a path argument the caller invents is ignored, not honoured', async (t) => {
  const { tool, fetchImpl, outputDir } = ttsTool(t)
  const smuggled = '/tmp/dsh-kokoro-should-never-exist.wav'

  const value = await tool.execute(
    { text: 'hello', path: smuggled, output: smuggled, filename: '../escape.wav' },
    exec,
  )

  assert.ok(value.path.startsWith(`${outputDir}/`), value.path)
  assert.notEqual(value.path, smuggled)
  assert.ok(!value.path.includes('escape'))
  assert.deepEqual(readdirSync(outputDir).length, 1)

  // And none of it reached the server either — the body is the three fields.
  assert.deepEqual(Object.keys(JSON.parse(fetchImpl.calls[0].init.body)).sort(), [
    'speed',
    'text',
    'voice',
  ])
})

test('two calls in the same directory do not collide', async (t) => {
  const { tool, outputDir } = ttsTool(t)

  const [first, second] = await Promise.all([
    tool.execute({ text: 'one' }, exec),
    tool.execute({ text: 'two' }, exec),
  ])

  assert.notEqual(first.path, second.path)
  assert.equal(readdirSync(outputDir).length, 2)
})

test('render projects the validated value into one text block naming the path', async (t) => {
  const { tool } = ttsTool(t)

  const value = await tool.execute({ text: 'Hello there.', voice: 'bm_george' }, exec)
  const blocks = tool.output.render({ text: 'Hello there.' }, value)

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes(value.path))
  assert.ok(blocks[0].text.includes('bm_george'))
  assert.ok(blocks[0].text.split('\n').length === 1)
})

test('invalid arguments fail loudly instead of executing', async (t) => {
  const { tool, fetchImpl, outputDir } = ttsTool(t)

  for (const args of [
    {},
    { text: 1 },
    { text: null },
    { voice: 'am_adam' },
    { text: 'hi', voice: 7 },
    { text: 'hi', speed: '1.5' },
    null,
    [],
    'hello',
  ]) {
    await assert.rejects(
      () => tool.execute(args, exec),
      (error) => {
        assert.ok(error instanceof ToolArgsError)
        assert.ok(error.violations.length > 0)
        return true
      },
      `expected ToolArgsError for ${JSON.stringify(args) ?? String(args)}`,
    )
  }

  // Validation runs before the body, so nothing was sent and nothing written.
  assert.deepEqual(fetchImpl.calls, [])
  assert.deepEqual(readdirSync(outputDir), [])
})

test('the manifest declares the bundle patch the profile installer looks for', () => {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.name, PLUGIN_NAME)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.engines.node, '>=22.14.0')
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-tools'], '0.1.1-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '^0.1.1-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '^4.0.1')
  assert.equal(manifest.dependencies, undefined)
  assert.ok(manifest.keywords.includes('dsh-plugin'))
  assert.ok(manifest.keywords.includes('tts'))

  const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
  const patch = readFileSync(patchPath, 'utf8')
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, new RegExp(`^\\s+- id: ${name}$`, 'm'))
  assert.match(patch, new RegExp(`^\\s+name: ${manifest.name}$`, 'm'))
})

test('nothing in this file reached the real network', () => {
  assert.deepEqual(guard.attempts, [])
  assert.equal(globalThis.fetch, guard)
})
