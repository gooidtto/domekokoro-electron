param([string]$Python = "python")
$ErrorActionPreference = "Stop"
& $Python -m pip install -U "kokoro-onnx" "soundfile" "misaki-fork[zh]"
if ($LASTEXITCODE -ne 0) { throw "Failed to install backend dependencies." }
Write-Host "Dome Kokoro backend dependencies installed."
