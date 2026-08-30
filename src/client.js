/**
 * The HTTP seam: one POST to a Kokoro server, and one write to a directory
 * this plugin owns.
 *
 * The server is https://github.com/jwilson411/kokoro-tts-api — a small local
 * FastAPI wrapper around Kokoro-82M. This plugin holds no model, no weights,
 * no voice tensors; it sends text and receives wav bytes.
 *
 * The request is deliberately narrow. Exactly one URL is ever built —
 * `{baseURL}/tts` — from a base that has already been checked to be an http(s)
 * origin, and redirects are not followed, so a misconfigured or hostile server
 * cannot bounce the request (or its text) to another host. The response is
 * bounded by a deadline and a byte cap, and its header is checked before any
 * of it lands on disk.
 *
 * The wav is written where this plugin decides: `os.tmpdir()/dsh-kokoro` by
 * default, or an operator-configured directory. A tool argument never chooses
 * a path — see {@link module:dsh-kokoro} for why the tool has no `path`
 * parameter at all.
 *
 * @module dsh-kokoro/client
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { KokoroError } from './errors.js'
import { assertWav, silentWav } from './wav.js'

/** This package's version, mirrored from the manifest for the User-Agent. */
export const VERSION = '0.1.0'

/**
 * The User-Agent every request sends, naming the plugin and its repository so
 * an operator reading their server's access log can tell who is calling.
 */
export const USER_AGENT = `dsh-kokoro/${VERSION} (+https://github.com/jwilson411/dsh-kokoro)`

/**
 * Where the plugin looks for a Kokoro server when nothing says otherwise.
 *
 * Note that `jwilson411/kokoro-tts-api` listens on **8765** by default
 * (`KOKORO_PORT`), so point `baseURL` — or `DSH_KOKORO_BASE_URL` — at
 * `http://127.0.0.1:8765` when that is the server you are running.
 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000'

/** The environment variable consulted when the patch row sets no base URL. */
export const BASE_URL_ENV = 'DSH_KOKORO_BASE_URL'

/** The environment variable that turns on the local silent-wav stub. */
export const STUB_ENV = 'KOKORO_STUB'

/** How long to wait for the server before failing closed. Synthesis is not instant. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** How many wav bytes to accept before failing closed. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

/** The subdirectory of `os.tmpdir()` this plugin writes into. */
export const OUTPUT_DIR_NAME = 'dsh-kokoro'

/** The one path on the server this plugin ever posts to. */
export const TTS_PATH = '/tts'

/**
 * Reduce a configured base URL to a bare origin-and-prefix with no trailing
 * slash, and refuse anything that is not http(s).
 *
 * The scheme check is the point: a `file:` or `data:` base would turn the one
 * outbound request into a local read.
 * @param raw - The configured base URL.
 * @returns The normalized base URL, without a trailing slash.
 * @throws {KokoroError} `KOKORO_BAD_BASE_URL` if it is unparseable or not http(s).
 */
export function normalizeBaseURL(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new KokoroError('KOKORO_BAD_BASE_URL', 'a Kokoro base URL is required')
  }

  let parsed
  try {
    parsed = new URL(raw.trim())
  } catch (cause) {
    throw new KokoroError('KOKORO_BAD_BASE_URL', `not a URL: ${JSON.stringify(raw)}`, { cause })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new KokoroError(
      'KOKORO_BAD_BASE_URL',
      `the Kokoro base URL must be http or https; got ${parsed.protocol}`,
    )
  }

  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
}

/**
 * The directory this plugin writes wavs into.
 * @param configured - An operator-configured directory, or undefined.
 * @returns An absolute directory path.
 */
export function resolveOutputDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return join(tmpdir(), OUTPUT_DIR_NAME)
}

/**
 * Read a response body, abandoning it the moment it exceeds the cap.
 * @param response - The fetch response.
 * @param maxBytes - The byte cap.
 * @param deadline - The timeout signal, consulted to classify a read failure.
 * @returns The body bytes.
 * @throws {KokoroError} `KOKORO_RESPONSE_TOO_LARGE`, `KOKORO_TIMEOUT`, or `KOKORO_UNREACHABLE`.
 */
async function readCapped(response, maxBytes, deadline) {
  const tooLarge = () =>
    new KokoroError('KOKORO_RESPONSE_TOO_LARGE', `the wav exceeded the ${maxBytes} byte cap`)

  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge()

  const body = response.body
  if (body === undefined || body === null || typeof body.getReader !== 'function') {
    // A response with no readable stream — the shape a hand-rolled double
    // takes. Cap it after the fact; there is nothing to stop early.
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw tooLarge()
    return buffer
  }

  const reader = body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(value)
    }
  } catch (cause) {
    if (cause instanceof KokoroError) throw cause
    if (deadline.aborted) {
      throw new KokoroError('KOKORO_TIMEOUT', 'the Kokoro server did not answer in time', { cause })
    }
    throw new KokoroError(
      'KOKORO_UNREACHABLE',
      `could not read the Kokoro response: ${cause.message}`,
      { cause },
    )
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * POST one utterance to `{baseURL}/tts` and return the wav bytes.
 *
 * With no injected `fetch` and `KOKORO_STUB=1` in the environment, no request
 * is made at all: a short silent wav is produced locally instead, so the rest
 * of the pipeline can be exercised without a server. That is an escape hatch
 * for demos, not a fallback — it never fires when a `fetch` was supplied, and
 * never masks a real failure.
 * @param request - `{ text, voice, speed }`, already checked against the allowlist and bounds.
 * @param options - `baseURL`, `fetch`, `timeoutMs`, `maxBytes`, `env`, and the caller's `signal`.
 * @returns The wav bytes the server produced.
 * @throws {KokoroError} On a bad base URL, timeout, non-2xx status, oversized or non-wav body.
 */
export async function synthesize(request, options = {}) {
  const {
    baseURL = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    env = process.env,
    signal,
  } = options
  const fetchImpl = options.fetch

  if (fetchImpl === undefined && env[STUB_ENV] === '1') {
    return silentWav()
  }

  const url = `${normalizeBaseURL(baseURL)}${TTS_PATH}`
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline
  const doFetch = fetchImpl ?? globalThis.fetch

  let response
  try {
    response = await doFetch(url, {
      method: 'POST',
      // Manual, not `follow`: the one host this plugin talks to is the one an
      // operator configured, and a 3xx to anywhere else would carry the text
      // being spoken with it. A redirect is reported as an HTTP error instead.
      redirect: 'manual',
      headers: {
        accept: 'audio/wav',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        text: request.text,
        voice: request.voice,
        speed: request.speed,
      }),
      signal: combined,
    })
  } catch (cause) {
    if (deadline.aborted) {
      throw new KokoroError(
        'KOKORO_TIMEOUT',
        `the Kokoro server at ${baseURL} did not answer within ${timeoutMs}ms`,
        { cause },
      )
    }
    // The caller cancelling is the caller's business, not a server failure:
    // let the harness see its own abort reason rather than a wrapped one.
    if (signal?.aborted) throw cause
    throw new KokoroError(
      'KOKORO_UNREACHABLE',
      `could not reach the Kokoro server at ${baseURL}: ${cause.message}`,
      { cause },
    )
  }

  const status = response.status ?? 0
  if (status < 200 || status >= 300) {
    throw new KokoroError(
      'KOKORO_HTTP_ERROR',
      `the Kokoro server at ${baseURL} answered ${status} for ${TTS_PATH}`,
    )
  }

  const contentType = response.headers?.get?.('content-type') ?? ''
  if (contentType !== '' && !/^audio\//i.test(contentType.trim())) {
    throw new KokoroError(
      'KOKORO_BAD_AUDIO',
      `the Kokoro server answered with ${contentType} rather than audio/wav`,
    )
  }

  return assertWav(await readCapped(response, maxBytes, deadline))
}

/**
 * Name one output file.
 *
 * The random component is what keeps two concurrent calls with the same voice
 * from colliding; the voice is in the name only so a directory of these is
 * readable.
 * @param voice - The allowlisted voice the wav was spoken in.
 * @returns A bare filename, no separators.
 */
export function outputFilename(voice) {
  return `kokoro-${voice}-${randomUUID()}.wav`
}

/**
 * Write wav bytes into the plugin's own output directory.
 *
 * The directory is created if missing, mode 0700, because on a shared host
 * `os.tmpdir()` is world-readable and synthesized speech is the caller's
 * content. The filename is generated here: nothing a caller passes reaches it.
 * @param bytes - The wav bytes, already header-checked.
 * @param options - `outputDir` to write into and the `voice` used, for the name.
 * @returns The absolute path written.
 * @throws {KokoroError} `KOKORO_WRITE_FAILED` if the directory or file cannot be written.
 */
export async function writeWav(bytes, options = {}) {
  const directory = resolveOutputDir(options.outputDir)
  const path = join(directory, outputFilename(options.voice ?? 'voice'))

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path, bytes, { mode: 0o600 })
  } catch (cause) {
    throw new KokoroError(
      'KOKORO_WRITE_FAILED',
      `could not write the wav under ${directory}: ${cause.message}`,
      { cause },
    )
  }

  return path
}
