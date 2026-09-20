# BookNote 本地 TTS 自动发现

Dome Kokoro 提供固定 loopback endpoint：

http://127.0.0.1:18451/api/v1/health

## Discovery

BookNote 启动时、Reader 打开时以及 TTS 面板显示时检查该地址。建议间隔 1500ms，仅在服务不可用时继续轮询。

服务必须返回：

- service = domekokoro-tts
- apiVersion = 1
- engine = kokoro-onnx
- endpoint = http://127.0.0.1:18451
- booknote.discoverable = true

## Synthesis

POST http://127.0.0.1:18451/api/v1/synthesize

{
  "text": "要朗读的内容",
  "voice": "zf_001",
  "speed": 1,
  "continuous": true,
  "timing": true
}

返回 WAV Base64 与可选 timing。

## 安全边界

仅监听 127.0.0.1，不接受局域网连接。BookNote 不需要知道 Python 路径，也不需要管理模型文件。

## 架构

Electron
 -> loopback HTTP API
 -> persistent Python worker
 -> kokoro-onnx
 -> Kokoro v1.1-zh INT8

第一阶段使用固定端口，确保 Firefox/BookNote 可以稳定检测。后续再做随机端口 + discovery token。
