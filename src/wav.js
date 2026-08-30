/**
 * The little that this plugin needs to know about the RIFF container.
 *
 * Two jobs, both small. {@link assertWav} checks that what came back over HTTP
 * really is a wav before any of it is written to disk — a proxy login page or
 * a JSON error body would otherwise land on disk with a `.wav` name and fail
 * much further away from the cause. {@link silentWav} synthesizes a valid,
 * silent wav locally so `KOKORO_STUB=1` can exercise the write-and-report path
 * with no server running.
 *
 * There is no decoder here, and no audio processing of any kind. The bytes the
 * server produced are the bytes that get written.
 *
 * @module dsh-kokoro/wav
 */
import { KokoroError } from './errors.js'

/** The sample rate Kokoro-82M renders at, used by the local stub only. */
export const SAMPLE_RATE = 24_000

/** How long a {@link silentWav} runs when the caller names no duration. */
export const STUB_SECONDS = 0.25

/** `RIFF` and `WAVE`, the two markers that make a buffer a wav. */
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WAVE = [0x57, 0x41, 0x56, 0x45]

/**
 * Whether a buffer opens with a RIFF/WAVE header.
 * @param bytes - The candidate payload.
 * @returns True if the first 12 bytes are a RIFF container declaring WAVE.
 */
export function isWavBytes(bytes) {
  if (!ArrayBuffer.isView(bytes) || bytes.byteLength < 12) return false
  const head = new Uint8Array(bytes.buffer, bytes.byteOffset, 12)
  return (
    RIFF.every((byte, index) => head[index] === byte) &&
    WAVE.every((byte, index) => head[8 + index] === byte)
  )
}

/**
 * Refuse anything that is not a wav, before it reaches the filesystem.
 * @param bytes - The response payload.
 * @returns The same bytes, once they are known to be a wav.
 * @throws {KokoroError} `KOKORO_BAD_AUDIO` if the header is missing or wrong.
 */
export function assertWav(bytes) {
  if (!isWavBytes(bytes)) {
    const size = ArrayBuffer.isView(bytes) ? bytes.byteLength : 0
    throw new KokoroError(
      'KOKORO_BAD_AUDIO',
      `the response was not a RIFF/WAVE payload (${size} bytes)`,
    )
  }
  return bytes
}

/**
 * Build a valid, silent, 16-bit mono wav.
 *
 * Used only by the `KOKORO_STUB=1` path, so a CI demo or a smoke test can walk
 * the whole tool — validate, write, report a path — without a Kokoro server.
 * It is silence: nothing here synthesizes speech, and no model is involved.
 * @param options - `seconds` of silence and the `sampleRate` to declare.
 * @returns The wav bytes.
 */
export function silentWav(options = {}) {
  const { seconds = STUB_SECONDS, sampleRate = SAMPLE_RATE } = options
  const frames = Math.max(1, Math.round(seconds * sampleRate))
  const dataBytes = frames * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index)
    }
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // format: uncompressed PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  // The samples themselves stay zero: that is what silence is.

  return bytes
}
