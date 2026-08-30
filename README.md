# dsh-kokoro

A small **DeepSeek Harness function plugin** that speaks text out loud. It
registers exactly one model-facing tool — `kokoro_tts` — which POSTs text to a
local [Kokoro TTS server](https://github.com/jwilson411/kokoro-tts-api), writes
the wav that comes back, and reports the path.

**No weights ship here.** No ONNX, no `.pt`, no voice bins, no embeddings —
nothing in this repository is model data, and nothing is downloaded at install
time. The model lives behind the server; this package is the wire to it. What
it does contain is a list of nineteen voice *names* and two numeric bounds,
mirrored from that server so a bad argument fails here instead of costing a
round trip.

It is also not an audio toolkit. There is no playback, no format conversion, no
mixing, no streaming, no caching, no transcription. It answers one question —
*what would this text sound like?* — and hands back a file path.

No API key, no credentials, no state.

## Install

```sh
dsh plugin --profile web add github:jwilson411/dsh-kokoro
```

`dsh plugin` forwards to pnpm inside `$DSH_HOME/profiles/web`, then reconciles
the profile against the installed state: because this package's manifest
declares `dsh.bundle.patch`, it is appended to the profile manifest's ordered
`dsh.profile.bundles` list and its patch becomes a layer.

Remove it the same way, with `remove` in place of `add`.

## Point it at a server

The plugin's built-in default base URL is **`http://127.0.0.1:8000`**.

The companion server, [`jwilson411/kokoro-tts-api`][api], listens on **8765** by
default (`KOKORO_PORT`). So if that is the server you are running — and it
probably is — set the base URL to `http://127.0.0.1:8765`. Either the patch row:

```yaml
- id: kokoro
  config:
    baseURL: http://127.0.0.1:8765
```

or the environment:

```sh
export DSH_KOKORO_BASE_URL=http://127.0.0.1:8765
```

The order is most specific first: the plugin's patch row, then
`DSH_KOKORO_BASE_URL`, then the default. A row that names `baseURL` is taken at
its word even when blank — writing the key and leaving it empty is a
misconfiguration, and it fails at load rather than quietly talking to a server
you did not name. Whatever wins is normalized (trailing slash stripped) and
scheme-checked immediately: anything that is not `http:` or `https:` is refused,
so a `file:` base cannot turn the one outbound request into a local read.

Bring the server up first — see its README for the weights step, which happens
over there, not here:

```sh
KOKORO_PORT=8765 make run    # in a checkout of jwilson411/kokoro-tts-api
curl -s http://127.0.0.1:8765/health
```

## Pinned DSH release candidate

This package is written and tested against the pinned release candidate
**`0.1.1-rc.2`** — the current `@deepseek-ai/dsh` release and the matching
`@deepseek-ai/dsh-tools@0.1.1-rc.2`, which is pinned exactly in
`devDependencies` so tests run against one known API. The peer range is
`^0.1.1-rc.2`, matching how the harness's own tool packages declare it.

Note that `@deepseek-ai/dsh-tools`'s npm `latest` tag still points at the older
`0.0.1-rc.1`; the `0.1.1-rc.2` line is published under `next`. Pin explicitly
rather than relying on the tag.

There are no runtime dependencies.

## What it registers

| | |
|---|---|
| Cordis plugin id | `kokoro` (the row id in `cordis.patch.yml`) |
| Injects | `tools` — a hard dependency; the plugin waits rather than degrading |

| Tool | Arguments | Returns |
|---|---|---|
| `kokoro_tts` | `text` (string, required, 1–8000 chars), `voice` (string, optional, allowlisted, default `am_michael`), `speed` (number, optional, 0.5–2.0, default 1.0) | `{ path, voice, speed, bytes, text_chars, plugin }` |

```json
{
  "path": "/tmp/dsh-kokoro/kokoro-am_michael-0f9c1f2e-....wav",
  "voice": "am_michael",
  "speed": 1,
  "bytes": 122444,
  "text_chars": 41,
  "plugin": "dsh-kokoro"
}
```

Nothing is played automatically. The path is reported so a caller can open it.

### Voices

Nineteen, allowlisted. `am_`/`af_` are American male and female, `bm_`/`bf_`
British male and female:

`am_michael` (default), `am_adam`, `am_liam`, `am_eric`, `am_james`,
`am_william`, `am_caleb`, `am_david`, `am_ethan`, `bm_daniel`, `bm_george`,
`bm_lewis`, `bm_oliver`, `af_heart`, `af_nova`, `af_sarah`, `af_bella`,
`bf_emma`, `bf_isabella`.

Any other name is refused with `KOKORO_BAD_VOICE` before the socket opens.

### Where the wav goes — and why you cannot choose

The tool has **no `path`, `output`, or `filename` argument**, and will not grow
one. A model choosing where bytes land is a file-write primitive wearing a
text-to-speech costume; a `path` argument on this tool would let any prompt that
reaches it write attacker-shaped bytes to an attacker-chosen location. So the
plugin picks: a file named `kokoro-<voice>-<uuid>.wav` inside a directory it
owns — `os.tmpdir()/dsh-kokoro` by default, created mode 0700, files written
0600 — and tells you the path afterwards. An operator can move that directory
with `config.outputDir` in the patch row. A caller cannot.

Nothing is cleaned up on your behalf; these are files under your temp directory,
and their lifetime is your system's business.

## Talking to Kokoro

Exactly one request is ever made, to exactly one URL: `POST {baseURL}/tts`, with
`{text, voice, speed}` as JSON, expecting `audio/wav` back. Redirects are **not**
followed — a 3xx is reported as `KOKORO_HTTP_ERROR` rather than carrying the
text being spoken to whatever host the `Location` header names.

Every request is bounded twice and fails closed on either bound: an
`AbortSignal` deadline (30s — synthesis is not instant) and a response byte cap
(10 MiB) enforced while the body streams, so an oversized response is abandoned
rather than buffered. Both are configurable from the patch row:

```yaml
- insert:
    - id: kokoro
      name: dsh-kokoro
      config:
        baseURL: http://127.0.0.1:8765
        timeoutMs: 30000
        maxBytes: 10485760
        outputDir: /var/tmp/dsh-kokoro
```

An id-targeted patch replaces the row's whole `config` rather than merging into
it, so an override must restate the fields it keeps.

What comes back is checked before any of it touches disk: the content type must
be `audio/*`, and the first twelve bytes must be a RIFF container declaring
WAVE. A proxy login page or a JSON error body served with a 200 fails as
`KOKORO_BAD_AUDIO` instead of landing on disk with a `.wav` name.

Failures carry a stable `code` — `KOKORO_BAD_TEXT`, `KOKORO_BAD_VOICE`,
`KOKORO_BAD_SPEED`, `KOKORO_BAD_BASE_URL`, `KOKORO_HTTP_ERROR`,
`KOKORO_BAD_AUDIO`, `KOKORO_RESPONSE_TOO_LARGE`, `KOKORO_TIMEOUT`,
`KOKORO_UNREACHABLE`, `KOKORO_WRITE_FAILED` — so a caller can tell a dead port
from a rejected voice without matching on prose. Requests identify themselves
with a `User-Agent` naming the plugin and this repository.

## Headless use

The tool factory takes both seams — the `fetch` to use and the directory to
write into — so you can drive it from a plain Node script without booting a
profile:

```js
// say.mjs — node say.mjs
import { createKokoroTtsTool } from 'dsh-kokoro'

// Omit `fetch` to use the global one and talk to a real server.
const tts = createKokoroTtsTool({ baseURL: 'http://127.0.0.1:8765' })

const { path, bytes } = await tts.execute(
  { text: 'The kettle is on.', voice: 'bm_george' },
  { signal: AbortSignal.timeout(60_000) },
)
console.log(`${bytes} bytes at ${path}`)
```

### `KOKORO_STUB=1`

With `KOKORO_STUB=1` in the environment **and** no injected `fetch`, no request
is made at all: a short silent wav is generated locally so the rest of the
pipeline — validate, write, report a path — can be walked with no server
running. It is silence, not speech; nothing here synthesizes audio and no model
is involved. Treat it as a demo and smoke-test hatch, not a fallback: it never
fires when a `fetch` was supplied, and it never masks a real failure.

## Tests

```sh
npm install
npm test
```

The suite is offline and needs no Kokoro server. Every request is answered by an
injected `fetch` double, and each test file replaces `globalThis.fetch` with a
guard that throws, so a code path that reached for the real network fails as a
test failure rather than a live request. Files are written into a throwaway
directory under `os.tmpdir()`, one per test, removed when it ends. CI runs it on
Node 22.x and 24.x with `contents: read` and no secrets.

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Justin Wilson.

The Kokoro-82M model and its weights are not part of this package and are not
covered by this licence; see [`jwilson411/kokoro-tts-api`][api] for those.

[api]: https://github.com/jwilson411/kokoro-tts-api
