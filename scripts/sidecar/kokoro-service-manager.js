const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { waitForHealthy } = require('./kokoro-health');

const DEFAULT_PORT = 17861;

class KokoroServiceManager {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number(options.port || process.env.KOKORO_PORT || DEFAULT_PORT);
    this.python = options.python || process.env.KOKORO_PYTHON || 'python3';
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '../..');
    this.process = null;
    this.ready = null;
  }

  getSidecarDir() {
    return path.join(this.projectRoot, 'sidecar', 'kokoro-onnx');
  }

  getDefaultModelDir() {
    return path.join(this.projectRoot, 'models', 'Kokoro-82M-v1.1-zh', 'int8');
  }

  getAssets() {
    const dir = process.env.KOKORO_MODEL_DIR || this.getDefaultModelDir();
    return {
      model: process.env.KOKORO_MODEL_PATH || path.join(dir, 'kokoro-v1.1-zh.int8.onnx'),
      voices: process.env.KOKORO_VOICES_PATH || path.join(dir, 'voices-v1.1-zh.bin'),
      config: process.env.KOKORO_CONFIG_PATH || path.join(dir, 'config.json'),
    };
  }

  async start() {
    if (this.ready) return this.ready;

    this.ready = (async () => {
      const assets = this.getAssets();
      for (const key of Object.keys(assets)) {
        if (!fs.existsSync(assets[key])) throw new Error('Kokoro asset missing: ' + key + '=' + assets[key]);
      }

      this.process = spawn(this.python, [
        path.join(this.getSidecarDir(), 'app.py'),
        '--host', this.host,
        '--port', String(this.port),
        '--model', assets.model,
        '--voices', assets.voices,
        '--config', assets.config,
      ], {
        cwd: this.getSidecarDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.process.stdout.on('data', data => console.log('[kokoro-sidecar]', data.toString().trim()));
      this.process.stderr.on('data', data => console.error('[kokoro-sidecar]', data.toString().trim()));
      this.process.once('exit', (code, signal) => {
        this.process = null;
        this.ready = null;
        console.log('[kokoro-sidecar] exited', { code, signal });
      });

      return waitForHealthy({ host: this.host, port: this.port }, 120000);
    })();

    try {
      return await this.ready;
    } catch (error) {
      this.stop();
      this.ready = null;
      throw error;
    }
  }

  stop() {
    if (!this.process) return;
    this.process.kill();
    this.process = null;
    this.ready = null;
  }
}

module.exports = { KokoroServiceManager };
