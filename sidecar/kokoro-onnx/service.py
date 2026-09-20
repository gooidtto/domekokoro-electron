from __future__ import annotations

import argparse
import io
import json
import os
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

import numpy as np
from misaki import zh
from kokoro_onnx import Kokoro

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17861
MAX_CHARS = 300
DEFAULT_VOICE = "zf_001"
SAMPLE_RATE = 24000


class KokoroService:
    def __init__(self, model_path: Path, voices_path: Path, config_path: Path | None):
        self.model_path = model_path
        self.voices_path = voices_path
        self.config_path = config_path
        self._lock = Lock()
        self._tts = None
        self._g2p = None

    def load(self):
        if not self.model_path.is_file():
            raise FileNotFoundError(f"Model not found: {self.model_path}")
        if not self.voices_path.is_file():
            raise FileNotFoundError(f"Voices bundle not found: {self.voices_path}")

        kwargs = {}
        if self.config_path and self.config_path.is_file():
            kwargs["vocab_config"] = str(self.config_path)

        self._tts = Kokoro(str(self.model_path), str(self.voices_path), **kwargs)
        self._g2p = zh.ZHG2P(version="1.1")

    @property
    def tts(self):
        if self._tts is None:
            self.load()
        return self._tts

    @property
    def g2p(self):
        if self._g2p is None:
            self.load()
        return self._g2p

    def voices(self):
        return sorted(self.tts.get_voices())

    def synthesize(self, text, voice, speed):
        text = text.strip()
        if not text:
            raise ValueError("input text is empty")
        if len(text) > MAX_CHARS:
            raise ValueError(f"input exceeds {MAX_CHARS} characters")
        if voice not in self.voices():
            raise ValueError(f"unsupported voice: {voice}")

        with self._lock:
            phonemes, _ = self.g2p(text)
            samples, sample_rate = self.tts.create(
                phonemes, voice=voice, speed=float(speed), is_phonemes=True
            )
        return to_wav(samples, int(sample_rate))


def to_wav(samples, sample_rate):
    data = np.asarray(samples, dtype=np.float32)
    data = np.clip(data, -1.0, 1.0)
    pcm = (data * 32767.0).astype(np.int16)

    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    service = None

    def log_message(self, fmt, *args):
        print("[kokoro-sidecar]", fmt % args)

    def json_response(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            try:
                voices = self.service.voices()
                self.json_response(200, {
                    "status": "ok",
                    "engine": "kokoro-onnx",
                    "model": "Kokoro-82M-v1.1-zh",
                    "dtype": "int8",
                    "device": "cpu",
                    "sample_rate": SAMPLE_RATE,
                    "voices": len(voices),
                    "ready": True
                })
            except Exception as exc:
                self.json_response(503, {"status": "error", "ready": False, "error": str(exc)})
            return

        if self.path == "/v1/voices":
            try:
                self.json_response(200, {"voices": self.service.voices()})
            except Exception as exc:
                self.json_response(503, {"error": str(exc)})
            return

        self.json_response(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            self.json_response(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            response_format = payload.get("response_format", "wav")
            if response_format != "wav":
                raise ValueError("only response_format=wav is supported")

            audio = self.service.synthesize(
                payload.get("input", ""),
                payload.get("voice", DEFAULT_VOICE),
                float(payload.get("speed", 1.0)),
            )
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(audio)
        except ValueError as exc:
            self.json_response(400, {"error": str(exc)})
        except Exception as exc:
            self.json_response(500, {"error": str(exc)})


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("KOKORO_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.getenv("KOKORO_PORT", DEFAULT_PORT)))
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--config")
    args = parser.parse_args()

    service = KokoroService(
        Path(args.model),
        Path(args.voices),
        Path(args.config) if args.config else None,
    )
    service.load()
    Handler.service = service

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[kokoro-sidecar] ready http://{args.host}:{args.port} voices={len(service.voices())}")
    server.serve_forever()
