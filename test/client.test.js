/**
 * The HTTP seam on its own: what one request looks like, and what every way it
 * can go wrong is called.
 *
 * The point of these is that a Kokoro server can fail in ways that all look
 * like "no audio" from the outside — a dead port, a proxy login page, a 500
 * from the model, a redirect somewhere else — and each has to arrive with a
 * code that says which. Nothing here opens a socket; the global `fetch` is a
 * guard that throws.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  DEFAULT_BASE_URL,
  TTS_PATH,
  USER_AGENT,
  createKokoroTtsTool,
  normalizeBaseURL,
  outputFilename,
  resolveOutputDir,
  silentWav,
  synthesize,
  writeWav,
} from '../src/index.js'
import {
  execContext,
  hangingFetch,
  networkGuard,
  recordingFetch,
  refusingFetch,
  tempOutputDir,
  wavFetch,
} from './helpers.js'

const guard = networkGuard()

const exec = execContext()

const WAV = silentWav({ seconds: 0.05 })

/** One utterance, already checked, ready to hand to {@link synthesize}. */
const REQUEST = { text: 'hello', voice: 'am_michael', speed: 1 }

test('a base URL is normalized to an origin with no trailing slash', () => {
  assert.equal(normalizeBaseURL('http://127.0.0.1:8765'), 'http://127.0.0.1:8765')
  assert.equal(normalizeBaseURL('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765')
  assert.equal(normalizeBaseURL('http://127.0.0.1:8765///'), 'http://127.0.0.1:8765')
  assert.equal(normalizeBaseURL('  https://kokoro.lan/  '), 'https://kokoro.lan')
  assert.equal(normalizeBaseURL('https://kokoro.lan/api/'), 'https://kokoro.lan/api')
})

test('a base URL that is not http(s) is refused', () => {
  for (const bad of ['file:///tmp', 'ftp://host/x', 'data:,x', 'ws://host', '', '   ', 42, null]) {
    assert.throws(
      () => normalizeBaseURL(bad),
      (error) => {
        assert.equal(error.code, 'KOKORO_BAD_BASE_URL')
        return true
      },
      `expected KOKORO_BAD_BASE_URL for ${JSON.stringify(bad)}`,
    )
  }
})

test('the only URL ever requested is {baseURL}/tts', async () => {
  const fetchImpl = wavFetch(WAV)

  await synthesize(REQUEST, { baseURL: 'https://kokoro.lan/api/', fetch: fetchImpl, env: {} })

  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, `https://kokoro.lan/api${TTS_PATH}`)
  assert.equal(fetchImpl.calls[0].init.headers['user-agent'], USER_AGENT)
  assert.equal(fetchImpl.calls[0].init.headers.accept, 'audio/wav')
})

test('redirects are not followed: a 3xx is a failure, not a second host', async () => {
  const fetchImpl = recordingFetch(
    () =>
      new Response('', {
        status: 302,
        headers: { location: 'http://evil.example/tts' },
      }),
  )

  await assert.rejects(
    () => synthesize(REQUEST, { baseURL: DEFAULT_BASE_URL, fetch: fetchImpl, env: {} }),
    (error) => {
      assert.equal(error.code, 'KOKORO_HTTP_ERROR')
      assert.match(error.message, /302/)
      return true
    },
  )
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual')
})

test('a non-2xx status fails with KOKORO_HTTP_ERROR', async () => {
  for (const status of [400, 422, 500, 502, 503]) {
    const fetchImpl = wavFetch('{"detail":"nope"}', {
      status,
      headers: { 'content-type': 'application/json' },
    })
    await assert.rejects(
      () => synthesize(REQUEST, { fetch: fetchImpl, env: {} }),
      (error) => {
        assert.equal(error.code, 'KOKORO_HTTP_ERROR')
        assert.match(error.message, new RegExp(String(status)))
        return true
      },
      `expected KOKORO_HTTP_ERROR for ${status}`,
    )
  }
})

test('a 200 that is not a wav fails with KOKORO_BAD_AUDIO', async () => {
  // A proxy login page, announced as HTML.
  const html = wavFetch('<html><body>sign in</body></html>', {
    headers: { 'content-type': 'text/html' },
  })
  await assert.rejects(
    () => synthesize(REQUEST, { fetch: html, env: {} }),
    (error) => {
      assert.equal(error.code, 'KOKORO_BAD_AUDIO')
      assert.match(error.message, /text\/html/)
      return true
    },
  )

  // And the harder case: the right content-type over the wrong bytes.
  const mislabelled = wavFetch(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]))
  await assert.rejects(
    () => synthesize(REQUEST, { fetch: mislabelled, env: {} }),
    (error) => {
      assert.equal(error.code, 'KOKORO_BAD_AUDIO')
      assert.match(error.message, /RIFF\/WAVE/)
      return true
    },
  )

  // A truncated wav is no wav either.
  const truncated = wavFetch(WAV.slice(0, 8))
  await assert.rejects(
    () => synthesize(REQUEST, { fetch: truncated, env: {} }),
    (error) => {
      assert.equal(error.code, 'KOKORO_BAD_AUDIO')
      return true
    },
  )
})

test('a wav past the byte cap is abandoned rather than buffered', async () => {
  const fetchImpl = wavFetch(silentWav({ seconds: 1 }))

  await assert.rejects(
    () => synthesize(REQUEST, { fetch: fetchImpl, maxBytes: 256, env: {} }),
    (error) => {
      assert.equal(error.code, 'KOKORO_RESPONSE_TOO_LARGE')
      return true
    },
  )

  // A declared content-length over the cap is refused without reading at all.
  const declared = wavFetch(WAV, {
    headers: { 'content-type': 'audio/wav', 'content-length': '999999999' },
  })
  await assert.rejects(
    () => synthesize(REQUEST, { fetch: declared, maxBytes: 1024, env: {} }),
    (error) => {
      assert.equal(error.code, 'KOKORO_RESPONSE_TOO_LARGE')
      return true
    },
  )
})

test('a server that never answers fails with KOKORO_TIMEOUT', async () => {
  const fetchImpl = hangingFetch()

  await assert.rejects(
    () => synthesize(REQUEST, { fetch: fetchImpl, timeoutMs: 25, env: {} }),
    (error) => {
      assert.equal(error.code, 'KOKORO_TIMEOUT')
      assert.match(error.message, /25ms/)
      return true
    },
  )
  assert.equal(fetchImpl.calls.length, 1)
})

test('a refused connection fails with KOKORO_UNREACHABLE, naming the base URL', async () => {
  await assert.rejects(
    () => synthesize(REQUEST, { baseURL: 'http://127.0.0.1:8765', fetch: refusingFetch(), env: {} }),
    (error) => {
      assert.equal(error.code, 'KOKORO_UNREACHABLE')
      assert.match(error.message, /127\.0\.0\.1:8765/)
      assert.match(error.message, /ECONNREFUSED/)
      return true
    },
  )
})

test("the caller's own cancellation surfaces as their abort, not a Kokoro failure", async () => {
  const controller = new AbortController()
  const fetchImpl = hangingFetch()
  const pending = synthesize(REQUEST, { fetch: fetchImpl, timeoutMs: 10_000, env: {} , signal: controller.signal })

  controller.abort(new Error('the harness cancelled this call'))

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, undefined)
    assert.match(error.message, /the harness cancelled this call/)
    return true
  })
})

test('a tool-level timeout fails loudly and writes nothing', async (t) => {
  const outputDir = tempOutputDir(t)
  const tool = createKokoroTtsTool({
    baseURL: 'http://127.0.0.1:8765',
    outputDir,
    env: {},
    fetch: hangingFetch(),
    timeoutMs: 25,
  })

  await assert.rejects(
    () => tool.execute({ text: 'hello' }, exec),
    (error) => {
      assert.equal(error.code, 'KOKORO_TIMEOUT')
      return true
    },
  )
  assert.deepEqual(readdirSync(outputDir), [])
})

test('a tool-level 500 fails loudly and writes nothing', async (t) => {
  const outputDir = tempOutputDir(t)
  const tool = createKokoroTtsTool({
    baseURL: 'http://127.0.0.1:8765',
    outputDir,
    env: {},
    fetch: wavFetch('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
  })

  await assert.rejects(
    () => tool.execute({ text: 'hello' }, exec),
    (error) => {
      assert.equal(error.code, 'KOKORO_HTTP_ERROR')
      return true
    },
  )
  assert.deepEqual(readdirSync(outputDir), [])
})

test('the default output directory is the plugin`s own, under the temp dir', () => {
  const fallback = resolveOutputDir()

  assert.ok(fallback.endsWith('dsh-kokoro'), fallback)
  assert.equal(resolveOutputDir('   '), fallback)
  assert.ok(resolveOutputDir('./somewhere').startsWith('/'))
})

test('a generated filename carries no caller input and no separators', () => {
  const first = outputFilename('am_michael')
  const second = outputFilename('am_michael')

  assert.match(first, /^kokoro-am_michael-[0-9a-f-]{36}\.wav$/)
  assert.notEqual(first, second)
  assert.ok(!first.includes('/'))
})

test('writeWav creates the directory and returns the path it wrote', async (t) => {
  const outputDir = `${tempOutputDir(t)}/nested/deeper`

  const path = await writeWav(WAV, { outputDir, voice: 'bf_emma' })

  assert.ok(path.startsWith(`${outputDir}/`))
  assert.equal(readFileSync(path).byteLength, WAV.byteLength)
  assert.deepEqual(readdirSync(outputDir).length, 1)
})

test('an unwritable output directory fails with KOKORO_WRITE_FAILED', async (t) => {
  // A file, not a directory: mkdir -p over it is the failure being checked.
  const outputDir = `${await writeWav(WAV, { outputDir: tempOutputDir(t), voice: 'af_nova' })}/under`

  await assert.rejects(
    () => writeWav(WAV, { outputDir, voice: 'af_nova' }),
    (error) => {
      assert.equal(error.code, 'KOKORO_WRITE_FAILED')
      return true
    },
  )
})

test('nothing in this file reached the real network', () => {
  assert.deepEqual(guard.attempts, [])
  assert.equal(globalThis.fetch, guard)
})
