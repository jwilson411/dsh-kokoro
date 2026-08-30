/**
 * dsh-kokoro — a DeepSeek Harness function plugin that speaks text through a
 * local Kokoro TTS HTTP server.
 *
 * The plugin registers exactly one model-facing tool against the `tools`
 * service and owns nothing else: `kokoro_tts` POSTs text to a Kokoro server,
 * writes the wav it gets back, and reports where it landed. **No weights ship
 * here** — no ONNX, no `.pt`, no voice tensors. The model lives behind the
 * companion server, https://github.com/jwilson411/kokoro-tts-api, and this
 * package is the wire to it.
 *
 * The tool has no `path`, `output`, or `filename` argument, and never will.
 * A model choosing where bytes land is a file-write primitive wearing a
 * text-to-speech costume; the write target is the plugin's own directory, and
 * the caller is told the path afterwards.
 *
 * Registration happens inside `apply` so the Cordis fiber owns the effect:
 * stopping, updating, or reloading the plugin unregisters the tool with no
 * bookkeeping here. Named exports preserve the loader's injection metadata.
 *
 * @module dsh-kokoro
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  normalizeBaseURL,
  resolveOutputDir,
  synthesize,
  writeWav,
} from './client.js'
import {
  DEFAULT_SPEED,
  DEFAULT_VOICE,
  MAX_SPEED,
  MAX_TEXT_CHARS,
  MIN_SPEED,
  VOICE_NAMES,
  assertSpeed,
  assertText,
  assertVoice,
} from './voices.js'

export { KokoroError, KOKORO_ERROR_CODES } from './errors.js'
export {
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  OUTPUT_DIR_NAME,
  STUB_ENV,
  TTS_PATH,
  USER_AGENT,
  normalizeBaseURL,
  outputFilename,
  resolveOutputDir,
  synthesize,
  writeWav,
} from './client.js'
export {
  DEFAULT_SPEED,
  DEFAULT_VOICE,
  KOKORO_VOICES,
  MAX_SPEED,
  MAX_TEXT_CHARS,
  MIN_SPEED,
  VOICE_NAMES,
  assertSpeed,
  assertText,
  assertVoice,
  isKnownVoice,
} from './voices.js'
export { SAMPLE_RATE, assertWav, isWavBytes, silentWav } from './wav.js'

/** The plugin's own identity, echoed by the tool so a caller can confirm the source. */
export const PLUGIN_NAME = 'dsh-kokoro'

/** The tool's model-facing name. */
export const KOKORO_TTS_TOOL_NAME = 'kokoro_tts'

/** Cordis plugin name, used in loader diagnostics and the runtime plugin tree. */
export const name = 'kokoro'

/**
 * `tools` is a hard dependency: with no registry there is nothing for this
 * plugin to do, so it waits rather than degrading.
 */
export const inject = ['tools']

/**
 * Resolve the plugin's effective settings.
 *
 * The base URL is looked for in one order, most specific first: the plugin's
 * patch row, then `DSH_KOKORO_BASE_URL`, then the built-in default. Whatever
 * wins is normalized and scheme-checked immediately, so a typo in a profile
 * fails at load rather than on the first utterance.
 * @param config - The `config` block of the plugin's row in the composed patch.
 * @param env - The environment to read, defaulting to `process.env`.
 * @returns The settings the tool is built with.
 * @throws {KokoroError} `KOKORO_BAD_BASE_URL` if the resolved base URL is not http(s).
 */
export function resolveConfig(config = {}, env = process.env) {
  // A row that mentions `baseURL` at all is taken at its word, blank included:
  // an operator who wrote the key meant to point this somewhere, and quietly
  // falling back would leave them talking to a server they never named. An
  // absent key is different, and so is a blank environment variable — neither
  // is a choice, so both defer to what is next in line.
  const named = Object.hasOwn(config, 'baseURL') && config.baseURL !== undefined && config.baseURL !== null
  const fromEnv = typeof env?.[BASE_URL_ENV] === 'string' ? env[BASE_URL_ENV].trim() : ''
  const chosen = named ? config.baseURL : fromEnv !== '' ? fromEnv : DEFAULT_BASE_URL

  return {
    baseURL: normalizeBaseURL(chosen),
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBytes: Number.isFinite(config.maxBytes) ? config.maxBytes : DEFAULT_MAX_BYTES,
    outputDir: resolveOutputDir(config.outputDir),
    env,
  }
}

/**
 * Build the `kokoro_tts` tool definition.
 *
 * Kept as a factory rather than a module-scope constant so nothing is
 * constructed at import time, each `apply` owns its own definition, and both
 * seams — the `fetch` and the output directory — can be substituted. Exported
 * so a host, or a test, can drive the tool without booting a profile.
 * @param options - `baseURL`, `outputDir`, `fetch`, `timeoutMs`, `maxBytes`, `env`.
 * @returns A registry-ready tool definition.
 */
export function createKokoroTtsTool(options = {}) {
  return defineTool({
    name: KOKORO_TTS_TOOL_NAME,
    description:
      'Speak text aloud with a local Kokoro text-to-speech server and return the path of the wav ' +
      'file it wrote. Reach for it to voice a summary, an answer, or a passage the user asked to ' +
      'hear. The file is written to a directory this plugin owns and its path is reported back — ' +
      'you cannot choose where it goes, and nothing is played automatically. Requires a running ' +
      'Kokoro server (github.com/jwilson411/kokoro-tts-api); it fails loudly if there is none.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description:
          `What to say, 1–${MAX_TEXT_CHARS} characters. Plain prose reads best; punctuation ` +
          'shapes the pacing. Longer passages must be split across calls.',
      },
      voice: {
        type: 'string',
        description:
          `Which voice to speak in (default \`${DEFAULT_VOICE}\`). One of: ` +
          `${VOICE_NAMES.join(', ')}. The \`am_\`/\`af_\` prefixes are American male and female, ` +
          '`bm_`/`bf_` British male and female. Any other name is refused.',
      },
      speed: {
        type: 'number',
        description:
          `Playback rate, ${MIN_SPEED}–${MAX_SPEED} (default ${DEFAULT_SPEED}). Values outside ` +
          'that range are refused rather than clamped.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            required: true,
            description:
              'Absolute path of the wav that was written, inside the directory this plugin owns.',
          },
          voice: {
            type: 'string',
            required: true,
            description: 'The voice it was spoken in, after the default was applied.',
          },
          speed: {
            type: 'number',
            required: true,
            description: 'The playback rate asked of the server, after the default was applied.',
          },
          bytes: { type: 'integer', required: true, description: 'Size of the wav on disk.' },
          text_chars: {
            type: 'integer',
            required: true,
            description: 'How many characters were spoken.',
          },
          plugin: {
            type: 'string',
            required: true,
            const: PLUGIN_NAME,
            description: 'The plugin that registered the tool that answered.',
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Spoke ${value.text_chars} character(s) as ${value.voice} at ${value.speed}x — ` +
            `${value.bytes} byte wav at ${value.path}`,
        },
      ],
    },
    async execute(args, exec) {
      // Every argument is checked before the socket opens: a bad voice or an
      // over-long text is this plugin's error to report, not a status code to
      // decode, and neither should cost a round trip or write a file.
      const text = assertText(args.text)
      const voice = assertVoice(args.voice)
      const speed = assertSpeed(args.speed)

      const bytes = await synthesize({ text, voice, speed }, { ...options, signal: exec?.signal })
      // Only now, with a header-checked wav in hand, does anything touch disk.
      const path = await writeWav(bytes, { outputDir: options.outputDir, voice })

      return {
        path,
        voice,
        speed,
        bytes: bytes.byteLength,
        text_chars: text.length,
        plugin: PLUGIN_NAME,
      }
    },
  })
}

/**
 * Register the tool for the lifetime of this plugin's fiber.
 * @param ctx - The injected Cordis context, with `tools` resolved.
 * @param config - The `config` block of this plugin's row in the composed patch.
 */
export function apply(ctx, config = {}) {
  ctx.tools.register(createKokoroTtsTool(resolveConfig(config)))
}
