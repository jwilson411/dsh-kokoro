/**
 * The container check that stands between the socket and the filesystem, and
 * the local stub that stands in for a server when there is not one.
 *
 * Nothing here ships or reads a model: `silentWav` writes zeroed PCM samples
 * into a hand-built 44-byte header. It is silence, and it exists so the write
 * path can be walked offline.
 */
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'

import {
  SAMPLE_RATE,
  assertWav,
  createKokoroTtsTool,
  isWavBytes,
  silentWav,
  synthesize,
} from '../src/index.js'
import { execContext, networkGuard, tempOutputDir } from './helpers.js'

const guard = networkGuard()

const exec = execContext()

test('a RIFF/WAVE header is recognised and anything else is not', () => {
  assert.ok(isWavBytes(silentWav()))

  const wav = silentWav()
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE')

  for (const notWav of [
    new Uint8Array(0),
    new Uint8Array(11),
    new Uint8Array([0x49, 0x44, 0x33, 0x04]), // an ID3 tag
    new TextEncoder().encode('{"detail":"unknown voice"}'),
    'RIFFxxxxWAVE',
    undefined,
    null,
    {},
  ]) {
    assert.equal(isWavBytes(notWav), false, `for ${JSON.stringify(notWav) ?? String(notWav)}`)
  }

  // A RIFF that is not a WAVE — an AVI, say — is refused too.
  const avi = silentWav()
  avi.set(new TextEncoder().encode('AVI '), 8)
  assert.equal(isWavBytes(avi), false)
})

test('assertWav returns the bytes it accepts and throws on the rest', () => {
  const wav = silentWav()

  assert.equal(assertWav(wav), wav)
  assert.throws(
    () => assertWav(new TextEncoder().encode('not audio')),
    (error) => {
      assert.equal(error.code, 'KOKORO_BAD_AUDIO')
      return true
    },
  )
})

test('the silent wav declares the fields a player needs', () => {
  const wav = silentWav({ seconds: 0.5, sampleRate: SAMPLE_RATE })
  const view = new DataView(wav.buffer)
  const frames = 0.5 * SAMPLE_RATE

  assert.equal(wav.byteLength, 44 + frames * 2)
  assert.equal(view.getUint32(4, true), 36 + frames * 2) // RIFF size
  assert.equal(view.getUint16(20, true), 1) // uncompressed PCM
  assert.equal(view.getUint16(22, true), 1) // mono
  assert.equal(view.getUint32(24, true), SAMPLE_RATE)
  assert.equal(view.getUint16(34, true), 16) // bits per sample
  assert.equal(view.getUint32(40, true), frames * 2) // data size
  assert.ok(wav.subarray(44).every((byte) => byte === 0)) // silence
})

test('KOKORO_STUB=1 answers locally, and only when no fetch was injected', async (t) => {
  const outputDir = tempOutputDir(t)
  const tool = createKokoroTtsTool({ outputDir, env: { KOKORO_STUB: '1' } })

  const value = await tool.execute({ text: 'no server needed', voice: 'af_sarah' }, exec)

  assert.ok(value.path.startsWith(`${outputDir}/`))
  assert.equal(value.voice, 'af_sarah')
  assert.ok(value.bytes > 44)
  assert.deepEqual(readdirSync(outputDir).length, 1)

  // The guard proves it: a real request would have thrown from `globalThis.fetch`.
  assert.deepEqual(guard.attempts, [])
})

test('the stub never fires when a fetch was injected, even with KOKORO_STUB=1', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return new Response(silentWav(), { headers: { 'content-type': 'audio/wav' } })
  }

  await synthesize(
    { text: 'x', voice: 'am_adam', speed: 1 },
    { fetch: fetchImpl, env: { KOKORO_STUB: '1' } },
  )

  assert.ok(called, 'the injected fetch must win over the stub')
})

test('the stub stays off unless the environment turns it on', async () => {
  await assert.rejects(
    () => synthesize({ text: 'x', voice: 'am_adam', speed: 1 }, { env: {} }),
    (error) => {
      // No injected fetch and no stub: it reaches for the global one, which
      // the guard replaced. Failing here is the point.
      assert.equal(error.code, 'KOKORO_UNREACHABLE')
      return true
    },
  )
  assert.equal(guard.attempts.length, 1)
  assert.equal(guard.attempts[0], 'http://127.0.0.1:8000/tts')
})

test('nothing in this file reached the real network', () => {
  assert.equal(globalThis.fetch, guard)
})
