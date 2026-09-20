import base64
import io
import json
import os
import sys
from pathlib import Path

MODEL_PATH = os.environ.get("DOMEKOKORO_MODEL_PATH", "")
VOICES_PATH = os.environ.get("DOMEKOKORO_VOICES_PATH", "")
CONFIG_PATH = os.environ.get("DOMEKOKORO_CONFIG_PATH", "")

_ENGINE = None
_G2P = None

def emit(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)

def engine():
    global _ENGINE, _G2P
    if _ENGINE is None:
        from kokoro_onnx import Kokoro
        from misaki import zh
        kwargs = {"vocab_config": CONFIG_PATH} if CONFIG_PATH and Path(CONFIG_PATH).exists() else {}
        _ENGINE = Kokoro(MODEL_PATH, VOICES_PATH, **kwargs)
        _G2P = zh.ZHG2P(version="1.1")
    return _ENGINE, _G2P

def to_wav(samples, sample_rate):
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    return buf.getvalue()

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        request_id = msg.get("id")
        try:
            engine_instance, g2p = engine()
            op = msg.get("op")

            if op == "ping":
                emit({"id": request_id, "ok": True, "status": "ready"})
                continue

            if op == "voices":
                emit({"id": request_id, "ok": True, "voices": engine_instance.get_voices()})
                continue

            if op == "synthesize":
                text = msg["text"]
                phonemes, _ = g2p(text)
                samples, rate, timings = engine_instance.create_timed(
                    phonemes,
                    voice=msg.get("voice", "zf_001"),
                    speed=float(msg.get("speed", 1.0)),
                    is_phonemes=True,
                    continuous=bool(msg.get("continuous", True))
                )
                payload = base64.b64encode(to_wav(samples, rate)).decode("ascii")
                emit({
                    "id": request_id,
                    "ok": True,
                    "sampleRate": rate,
                    "format": "wav",
                    "audioBase64": payload,
                    "timing": [t.__dict__ for t in timings] if msg.get("timing") else []
                })
                continue

            raise ValueError('Unknown operation: ' + str(op))
        except Exception as exc:
            emit({"id": request_id, "ok": False, "error": str(exc)})

if __name__ == '__main__':
    main()
