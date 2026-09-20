# DomeKokoro Kokoro-ONNX Runtime V2

## Current branch

`runtime-v2-kokoro-onnx-v11zh`

This branch starts the final Chinese runtime migration from the previous
`kokoro-js-zh` experiment to a Python `kokoro-onnx` sidecar.

## Implemented in this phase

- Python sidecar under `sidecar/kokoro-onnx/`
- Kokoro v1.1-zh G2P via Misaki ZHG2P v1.1
- local INT8 model path
- `voices-v1.1-zh.bin` voice bundle path
- GET `/health`
- GET `/v1/voices`
- POST `/v1/audio/speech`
- one cached Kokoro instance
- serialized inference using a process-local lock
- 300-character request guardrail
- Electron sidecar process manager
- Electron HTTP client and health waiter
- Git ignore rules for model binaries

The upstream Chinese example uses `zh.ZHG2P(version="1.1")` and passes
phonemes into `Kokoro.create(..., is_phonemes=True)`. The v1.1 model release
contains INT8, FP16 and FP32 variants and a 103-voice v1.1-zh bundle.

## Local asset layout

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

The binary assets are not committed to GitHub.

## Runtime policy

The sidecar is deliberately conservative:

1. load one model instance;
2. serialize inference;
3. reject requests above 300 characters;
4. discover voices from the installed voice bundle;
5. return WAV directly;
6. keep Electron responsible for lifecycle and API integration.

Long text will be chunked and merged by the Electron layer in the next phase,
not by parallel sidecar workers.

## Current supplied assets

The uploaded `voices.zip` contains ten individual JS-runtime voice files:
`zf_001`, `zf_002`, `zf_003`, `zf_018`, `zf_073`, `zm_009`,
`zm_010`, `zm_011`, `zm_012`, and `zm_089`.

Those files remain useful as reference/test assets for the previous
Transformers.js path. The V2 runtime is standardized on the
`kokoro-onnx` voice bundle `voices-v1.1-zh.bin`.

## Next phase

1. connect `main.js` IPC to `KokoroServiceManager`;
2. replace the Chinese JS IPC implementation with the sidecar-backed path;
3. add ordered 300-character chunking and WAV merge;
4. add a sidecar smoke-test script;
5. perform real INT8 synthesis with `zf_001`;
6. verify all installed voices;
7. only after real synthesis succeeds, expose the OpenAI-compatible facade;
8. then add FP16/FP32 model profiles.

## Verification status

No real ONNX synthesis has been claimed yet. The current environment has not
installed the Python sidecar dependencies and does not have the full release
asset set mounted. The GitHub implementation is therefore a code-level phase
completion, not a runtime-test pass.
