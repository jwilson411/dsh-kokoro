# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for a security report.

Use GitHub's private advisory form:

https://github.com/jwilson411/dsh-kokoro/security/advisories/new

Include the version or commit, steps to reproduce, and what an attacker gains.

## Scope

dsh-kokoro is a DeepSeek Harness function plugin. It registers one model-facing tool, `kokoro_tts`. The tool POSTs `{text, voice, speed}` as JSON to `{baseURL}/tts` on a local Kokoro HTTP server and writes the wav that comes back.

This repository does not ship model weights, ONNX files, voice bins, or embeddings. Nothing is downloaded at install time. The model lives behind the companion server; this package is the HTTP client.

The default `baseURL` is `http://127.0.0.1:8000`. The companion `jwilson411/kokoro-tts-api` listens on 8765 by default, so operators usually set `http://127.0.0.1:8765`. The scheme is checked at load: only `http:` and `https:` are accepted, so a `file:` base cannot turn the one outbound request into a local read. Redirects are not followed. There is no API key.

The tool has no `path`, `output`, or `filename` argument. Wav bytes land in a directory this plugin owns (`os.tmpdir()/dsh-kokoro` by default, or `config.outputDir` from the patch row), created mode 0700, files written 0600. The filename is `kokoro-<voice>-<uuid>.wav`. A caller cannot choose the write target. Content-type must be `audio/*` and the first twelve bytes must be a RIFF/WAVE header before any bytes touch disk. Every request fails closed on a 30s deadline and a 10 MiB response cap.

`KOKORO_STUB=1` with no injected `fetch` writes a short silent wav locally and opens no socket. It is a smoke-test hatch, not a fallback.

Pointing `baseURL` at a remote host is a deployment choice. An attacker who already controls the process running the harness, or who can reach a Kokoro server you exposed beyond loopback without a network boundary, is out of scope.

## Supported versions

Only the latest release receives security fixes.
