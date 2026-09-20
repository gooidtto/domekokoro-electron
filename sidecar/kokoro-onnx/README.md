# Kokoro v1.1-zh Sidecar

Phase 2 runtime boundary for DomeKokoro.

## Responsibilities

- Electron owns desktop UI, lifecycle, IPC, settings, and output-file management.
- Python owns Kokoro G2P, ONNX Runtime inference, voice bundle loading, and WAV synthesis.
- The HTTP boundary is localhost-only: `127.0.0.1:17861`.
- API surface:
  - `GET /health`
  - `GET /v1/voices`
  - `POST /v1/audio/speech`

## Model layout

The Electron repository intentionally does not commit model binaries.

```
models/
└── Kokoro-82M-v1.1-zh/
    └── int8/
        ├── kokoro-v1.1-zh.int8.onnx
        ├── voices-v1.1-zh.bin
        └── config.json
```

The service manager can override paths with:

- `KOKORO_MODEL_DIR`
- `KOKORO_MODEL_PATH`
- `KOKORO_VOICES_PATH`
- `KOKORO_CONFIG_PATH`
- `KOKORO_PYTHON`
- `KOKORO_PORT`

## Phase 2 constraints

- One Python Kokoro instance.
- One inference lock; requests are serialized.
- Maximum 300 input characters per synthesis request.
- Electron long-text synthesis splits text into <=300-character chunks and sends them sequentially.
- Streaming is deliberately deferred until batch synthesis is validated.
- No claim of successful real synthesis is made until the sidecar verifier is run on a machine with the Python environment and model assets installed.
