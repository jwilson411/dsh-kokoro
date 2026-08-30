/**
 * The one error type this plugin fails with, carrying a stable
 * machine-readable code so a caller can tell a dead server from a rejected
 * voice without matching on prose.
 *
 * @module dsh-kokoro/errors
 */

/** Every code {@link KokoroError} is thrown with, and what each one means. */
export const KOKORO_ERROR_CODES = Object.freeze({
  KOKORO_BAD_AUDIO: 'The response body was not a RIFF/WAVE payload.',
  KOKORO_BAD_BASE_URL: 'The configured base URL is not an http(s) origin.',
  KOKORO_BAD_SPEED: 'The speed argument is outside the supported range.',
  KOKORO_BAD_TEXT: 'The text argument was blank or longer than the cap.',
  KOKORO_BAD_VOICE: 'The voice argument is not on the allowlist.',
  KOKORO_HTTP_ERROR: 'The Kokoro server answered with a non-2xx status.',
  KOKORO_RESPONSE_TOO_LARGE: 'The wav exceeded the configured size cap.',
  KOKORO_TIMEOUT: 'The request was aborted before the server answered.',
  KOKORO_UNREACHABLE: 'The request to the Kokoro server could not be completed.',
  KOKORO_WRITE_FAILED: 'The wav could not be written to the plugin output directory.',
})

/** A failure synthesizing speech through a Kokoro HTTP server. */
export class KokoroError extends Error {
  /**
   * @param code - One of the keys of {@link KOKORO_ERROR_CODES}.
   * @param message - What went wrong, in prose, for a human reading a log.
   * @param options - Standard `Error` options; `cause` is preserved.
   */
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'KokoroError'
    /** @type {string} The stable code callers branch on. */
    this.code = code
  }
}
