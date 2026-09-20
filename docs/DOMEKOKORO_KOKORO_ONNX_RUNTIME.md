# DomeKokoro Kokoro-ONNX Runtime V2

## Purpose

This branch migrates production Chinese Kokoro inference from the historical JavaScript runtime to a Python `kokoro-onnx` sidecar.

## Runtime boundary

```
BookNote
  │ OpenAI-compatible HTTP
  │ 127.0.0.1:17860
  ▼
DomeKokoro Electron
  │ localhost HTTP
  │ 127.0.0.1:17861
  ▼
Python kokoro-onnx
  ├── Misaki ZHG2P 1.1
  ├── Kokoro v1.1-zh INT8 ONNX
  ├── voices-v1.1-zh.bin
  └── ONNX Runtime CPU
```

## Model hierarchy

```
models/
└── Kokoro-82M-v1.1-zh/
    ├── int8/
    │   ├── kokoro-v1.1-zh.int8.onnx
    │   ├── voices-v1.1-zh.bin
    │   └── config.json
    ├── fp16/
    │   ├── kokoro-v1.1-zh.fp16.onnx
    │   ├── voices-v1.1-zh.bin
    │   └── config.json
    └── fp32/
        ├── kokoro-v1.1-zh.onnx
        ├── voices-v1.1-zh.bin
        └── config.json
```

ONNX and voice binaries are intentionally excluded from Git.

## Phase 1

Phase 1 established:

- Python sidecar service.
- Single Kokoro instance.
- Serialized inference using a process-local lock.
- 300-character synthesis limit.
- Health and voice endpoints.
- Node HTTP client.
- Electron-side service lifecycle manager.
- Local model path overrides.

## Phase 2

Phase 2 connects the Electron application to the sidecar and exposes the BookNote-facing HTTP API.

### Electron API

- `GET /health`
- `GET /v1/models`
- `GET /v1/voices`
- `POST /v1/audio/speech`

Speech requests use this OpenAI-compatible shape:

```json
{
  "model": "kokoro-v1.1-zh",
  "input": "需要合成的中文文本",
  "voice": "zf_001",
  "speed": 1.0,
  "response_format": "wav"
}
```

The Electron API listens on `127.0.0.1:17860` by default.

The Python sidecar listens on `127.0.0.1:17861` by default.

### Long text

The single-inference guardrail remains 300 characters.

Electron's existing long-text path splits text into chunks no longer than 300 characters and sends them sequentially to the sidecar. This preserves the V10.7 memory-safety principle: no parallel Kokoro inference.

### Dependency boundary

Production inference no longer imports `kokoro-js`, `kokoro-js-zh`, Transformers.js, or Node ONNX Runtime from the Electron main process.

The Python sidecar owns:

- Chinese G2P.
- Kokoro model loading.
- Voice bundle loading.
- ONNX Runtime execution.
- WAV synthesis.

Electron owns:

- UI.
- IPC.
- sidecar lifecycle.
- HTTP API.
- settings.
- output file management.

### Streaming

Streaming is deliberately deferred. Phase 2 validates the stable batch path first.

### Environment overrides

Electron sidecar configuration:

- `KOKORO_PYTHON`
- `KOKORO_PORT`
- `KOKORO_MODEL_DIR`
- `KOKORO_MODEL_PATH`
- `KOKORO_VOICES_PATH`
- `KOKORO_CONFIG_PATH`

BookNote-facing API configuration:

- `KOKORO_API_HOST`
- `KOKORO_API_PORT`

## Validation

`npm run test:tts-runtime-v2:health` checks sidecar startup and health.

`npm run test:tts-runtime-v2` checks:

1. sidecar startup;
2. health response;
3. voice enumeration;
4. real Chinese synthesis;
5. RIFF/WAVE response validation.

These tests require the Python environment and local model assets. No real synthesis result is claimed until the verifier is executed on a machine containing those dependencies and assets.

## Current model asset note

The repository does not assume that an arbitrary 114 MB ONNX file is compatible merely because its size is similar to an upstream INT8 release. The actual model file, voice bundle, and configuration must be validated together before the model package is treated as a production asset.
