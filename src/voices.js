/**
 * The voice allowlist and the argument bounds, mirrored from the companion
 * server at https://github.com/jwilson411/kokoro-tts-api.
 *
 * The server rejects an unknown voice with HTTP 400 and an over-long text with
 * HTTP 422. This plugin checks first, so a bad argument fails with a code that
 * says what was wrong instead of a status that does not — and, more usefully,
 * without a pointless round trip. These are voice *names*, not voice data: no
 * embeddings, no `.pt` files, no bins are shipped here.
 *
 * @module dsh-kokoro/voices
 */
import { KokoroError } from './errors.js'

/** Every voice the server accepts, with the description it reports on `/voices`. */
export const KOKORO_VOICES = Object.freeze({
  am_michael: 'American male, confident, firm but gentle',
  am_adam: 'American male, warm, smooth',
  am_liam: 'American male, friendly, grounded',
  am_eric: 'American male, steady, calm',
  am_james: 'American male, confident, refined',
  am_william: 'American male, classic, authoritative',
  am_caleb: 'American male, youthful, earnest',
  am_david: 'American male, strong, measured',
  am_ethan: 'American male, warm, engaging',
  bm_daniel: 'British male, light, refined',
  bm_george: 'British male, classic BBC',
  bm_lewis: 'British male, youthful',
  bm_oliver: 'British male, bright, modern',
  af_heart: 'American female, warm, versatile',
  af_nova: 'American female, smooth, melodic',
  af_sarah: 'American female, soft, natural',
  af_bella: 'American female, warm, gentle',
  bf_emma: 'British female, clear, warm',
  bf_isabella: 'British female, elegant, refined',
})

/** The allowlisted names, in the order the server lists them. */
export const VOICE_NAMES = Object.freeze(Object.keys(KOKORO_VOICES))

/** The voice used when the caller names none. */
export const DEFAULT_VOICE = 'am_michael'

/** The longest text the server will accept in one request. */
export const MAX_TEXT_CHARS = 8000

/** The playback rate bounds the server enforces, and the neutral default. */
export const MIN_SPEED = 0.5
export const MAX_SPEED = 2.0
export const DEFAULT_SPEED = 1.0

/**
 * Whether a name is on the allowlist.
 * @param name - A candidate voice name.
 * @returns True if the server would accept it.
 */
export function isKnownVoice(name) {
  return typeof name === 'string' && Object.hasOwn(KOKORO_VOICES, name)
}

/**
 * Resolve the voice to synthesize with.
 * @param voice - The caller's `voice` argument, or undefined for the default.
 * @returns An allowlisted voice name.
 * @throws {KokoroError} `KOKORO_BAD_VOICE` if the name is not on the allowlist.
 */
export function assertVoice(voice) {
  if (voice === undefined || voice === null) return DEFAULT_VOICE
  if (!isKnownVoice(voice)) {
    throw new KokoroError(
      'KOKORO_BAD_VOICE',
      `unknown voice ${JSON.stringify(voice)}; expected one of ${VOICE_NAMES.join(', ')}`,
    )
  }
  return voice
}

/**
 * Check the text to speak against the server's bounds.
 *
 * Returned unchanged rather than trimmed: leading and trailing space can carry
 * pacing, and silently editing what a caller asked to be spoken would be a
 * surprise. Only an entirely blank string is refused.
 * @param text - The caller's `text` argument.
 * @returns The same text.
 * @throws {KokoroError} `KOKORO_BAD_TEXT` if it is blank or over {@link MAX_TEXT_CHARS}.
 */
export function assertText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new KokoroError('KOKORO_BAD_TEXT', 'text to speak is required and cannot be blank')
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new KokoroError(
      'KOKORO_BAD_TEXT',
      `text is ${text.length} characters; the server accepts at most ${MAX_TEXT_CHARS}`,
    )
  }
  return text
}

/**
 * Resolve the playback rate.
 *
 * Out-of-range values are refused rather than clamped: a caller asking for 4x
 * wants 4x, and quietly handing back 2x would misreport what was spoken.
 * @param speed - The caller's `speed` argument, or undefined for the default.
 * @returns A rate in `[MIN_SPEED, MAX_SPEED]`.
 * @throws {KokoroError} `KOKORO_BAD_SPEED` if it is outside the range.
 */
export function assertSpeed(speed) {
  if (speed === undefined || speed === null) return DEFAULT_SPEED
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new KokoroError(
      'KOKORO_BAD_SPEED',
      `speed must be a number in ${MIN_SPEED}–${MAX_SPEED}; got ${JSON.stringify(speed)}`,
    )
  }
  return speed
}
