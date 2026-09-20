#!/usr/bin/env bash
set -euo pipefail
PYTHON_BIN="${PYTHON_BIN:-python3}"
"$PYTHON_BIN" -m pip install -U "kokoro-onnx" "soundfile" "misaki-fork[zh]"
echo "Dome Kokoro backend dependencies installed."
