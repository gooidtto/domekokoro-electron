# DomeKokoro Runtime v1 — V10.7 Kokoro Baseline

This branch ports the production-critical parts of DomeAI V10.7's local Kokoro fixes into the Electron runtime.

## Source baseline

DomeAI local Kokoro was introduced in the V10.7 line and removed by:

- V10.7 baseline: `c923dc2068245a31bb3efa632e508e3870cb4c9b`
- local-Kokoro/default-engine change: `b2bb29c47348872a7d24c7d8e920a142639abc86`
- later removal: `deb87af703c39c5182e3160bbc5cb2b335211dca`

The recovered V10.7 runtime used:

- `kokoro-js-zh@2.1.7`
- `@huggingface/transformers@3.8.1`
- top-level `onnxruntime-node@1.29.0`
- `onnx-community/Kokoro-82M-v1.0-ONNX`
- `dtype=q8` on the server CPU runtime
- 8 Chinese voices: `zf_xiaoxiao`, `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoyi`, `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang`

## Four production fixes recovered

### 1. Low-memory tuning

Original V10.7 production environment was constrained by a 1.8 GiB host. The documented mitigation was:

- cap Next.js V8 heap at 768 MiB;
- reserve memory for ONNX Runtime;
- keep Kokoro text chunks small;
- do not solve the problem by lowering WAV sample rate.

Electron has no Next.js server process, so this branch does not add `NODE_OPTIONS` to the Electron renderer/main process. The equivalent runtime protection is implemented at the inference layer.

### 2. Kokoro synthesis serialization

This is directly applicable and is implemented in `scripts/tts-manager.js`.

All synthesis requests now pass through one Promise queue and one cached Kokoro instance:

```text
request A ─┐
request B ─┼──> Promise queue ──> one ONNX inference at a time
request C ─┘
```

The queue is failure-safe: a rejected request does not poison later requests.

The previous Electron implementation created additional Kokoro instances for multi-text generation and ran them with `Promise.all`. Runtime v1 removes that memory-multiplication path.

### 3. Docker Compose ENABLE_LOCAL_TTS fix

This was a deployment-specific V10.7 bug:

```text
docker-compose.yml
  build.args.ENABLE_LOCAL_TTS = "0"
        ↓
overrode rebuild.sh --build-arg ENABLE_LOCAL_TTS=1
        ↓
Kokoro dependencies were never installed
```

DomeKokoro Electron is not Docker/Compose based, so there is no equivalent change to apply. The baseline records this as a non-applicable source fix rather than inventing a Docker layer that the product does not use.

### 4. Next.js webpack createRequire stub fix

The original server used `createRequire(import.meta.url)` / `require.resolve()` to locate `kokoro-js-zh`. Next.js production webpack converted that path into a throwing MODULE_NOT_FOUND stub.

The V10.7 fix replaced package resolution with filesystem discovery from `process.cwd()` upward.

DomeKokoro Electron runs Node directly and does not pass `main.js` through the affected Next.js webpack server bundle, so the exact workaround is not needed here. Runtime v1 therefore keeps normal Node module resolution.

## Additional v1 guardrail

The V10.7 server route rejected Kokoro requests over 300 characters. Runtime v1 applies the same 300-character maximum inside the TTS manager, so every IPC caller receives the same safety boundary.

The long-text IPC path also chunks at 300 characters and uses the serialized manager rather than constructing parallel model instances.

## Important compatibility note

The current Electron application still depends on `kokoro-js@^1.2.1` and its existing cross-platform `fp16` configuration. This branch deliberately does **not** silently replace that dependency with `kokoro-js-zh@2.1.7` because doing so would change the current application's voice/model/runtime contract.

Therefore this branch is:

**V10.7 production memory/concurrency baseline applied to the existing Electron runtime**, not yet the final Chinese `kokoro-js-zh@2.1.7` engine migration.

The next isolated step is to add the Chinese runtime as a separate engine implementation, pin its dependency graph, and run real synthesis tests before making it the default engine.


## 2026-09-20 continuation: Chinese runtime isolated integration

The runtime-v1 branch now contains an isolated Chinese Kokoro implementation in
`scripts/chinese-kokoro-runtime.js`.

Target runtime:
- `kokoro-js-zh@2.1.7`
- `@huggingface/transformers@3.8.1`
- `onnxruntime-node@1.29.0`
- `onnx-community/Kokoro-82M-v1.0-ONNX`
- `q8`
- CPU inference
- 8 Chinese voices
- 300-character per-inference guardrail
- serialized single-instance inference

The existing `kokoro-js@1.2.1` runtime remains the current default path. The
Chinese runtime is exposed through separate IPC handlers so it can be validated
without replacing the existing engine:

- `initialize-kokoro-zh`
- `list-kokoro-zh-voices`
- `run-kokoro-zh`
- `get-kokoro-zh-config`

This is deliberate: the Chinese engine must pass real initialization,
voice-asset validation, Chinese synthesis, WAV validation, and memory/repeat
tests before becoming the default runtime.

Note: the repository package manifest has been updated with the three V10.7
Chinese runtime dependencies, but the lockfile has not yet been regenerated in
this environment because external package registry access is unavailable.
Do not treat a clean `npm ci` result as verified until the lockfile is
regenerated and the dependency tree is installed in a network-enabled build
environment.
