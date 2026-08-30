/**
 * Shared offline scaffolding. Not a test file: the `npm test` glob only picks
 * up `*.test.js`, so nothing here runs on its own.
 *
 * Two hazards to keep out of the suite, and a helper for each. {@link
 * networkGuard} replaces `globalThis.fetch` so a code path that forgot its
 * injected `fetch` fails as a test failure rather than reaching for a Kokoro
 * server that is not there. {@link tempOutputDir} hands every test its own
 * throwaway directory under `os.tmpdir()`, so a suite that writes wavs never
 * writes into the real plugin output directory and never leaves bytes behind.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Thrown by the guard when something reaches for the real global `fetch`. */
export const GUARD_MESSAGE = 'the offline test suite attempted a real network request'

/**
 * Replace the global `fetch` with one that fails loudly.
 *
 * Called at import time by every test file. `node --test` runs each file in
 * its own process, so this never leaks between files.
 * @returns The guard, which records the calls it refused.
 */
export function networkGuard() {
  const attempts = []
  const guard = (url) => {
    attempts.push(String(url))
    throw new Error(GUARD_MESSAGE)
  }
  guard.attempts = attempts
  globalThis.fetch = guard
  return guard
}

/**
 * A `fetch` double that records every call and delegates to a handler.
 * @param handler - Receives `(url, init)` and returns the response.
 * @returns The double, with a `calls` array of `{ url, init }`.
 */
export function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

/**
 * A `fetch` double answering every call with the same body.
 * @param body - The response body: wav bytes, or a string for the failure cases.
 * @param init - Response overrides, e.g. `{ status: 500 }` or different headers.
 * @returns The double, with a `calls` array.
 */
export function wavFetch(body, init = {}) {
  return recordingFetch(
    () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
        ...init,
      }),
  )
}

/**
 * A `fetch` double that never answers, for exercising the deadline.
 *
 * It holds a referenced timer for the life of the call. A real request keeps
 * the event loop alive through its socket, but `AbortSignal.timeout`'s own
 * timer is unreferenced by design — so without this, a test awaiting nothing
 * but the deadline drains the loop and `node --test` cancels it as pending.
 * @returns The double, with a `calls` array.
 */
export function hangingFetch() {
  return recordingFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000)
        init.signal.addEventListener(
          'abort',
          () => {
            clearInterval(keepAlive)
            reject(init.signal.reason)
          },
          { once: true },
        )
      }),
  )
}

/**
 * A `fetch` double that fails the way an unreachable host does.
 * @param message - The transport error message.
 * @returns The double, with a `calls` array.
 */
export function refusingFetch(message = 'connect ECONNREFUSED 127.0.0.1:8765') {
  return recordingFetch(() => {
    throw new TypeError(`fetch failed: ${message}`)
  })
}

/**
 * Make a throwaway output directory, removed when the test ends.
 *
 * Each call gets its own directory, so tests that count files in one are not
 * reading another's leftovers.
 * @param t - The `node:test` context, used to register the cleanup.
 * @returns The absolute directory path.
 */
export function tempOutputDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-kokoro-test-'))
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

/** The execution context the registry passes to `execute`. */
export function execContext() {
  return { signal: new AbortController().signal }
}

/**
 * A context stub exposing only what `apply` is allowed to touch.
 * @returns The stub context and the definitions it recorded.
 */
export function stubContext() {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}
