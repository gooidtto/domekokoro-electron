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
    this.packaged = Boolean(process.resourcesPath && process.defaultApp === false);
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '../..');
    this.process = null;
    this.ready = null;
  }

  getSidecarDir() {
    if (this.packaged) return path.join(process.resourcesPath, 'kokoro-sidecar');
    return path.join(this.projectRoot, 'sidecar', 'kokoro-onnx');
  }

  getModelRoot() {
    if (this.packaged) return path.join(process.resourcesPath, 'models', 'Kokoro-82M-v1.1-zh', 'runtime');
    return this.getDefaultModelDir();
  }

  getExecutable() {
    if (!this.packaged) {
      return { command: this.python, args: [path.join(this.getSidecarDir(), 'app.py')] };
    }
    const executable = process.platform === 'win32' ? 'kokoro-sidecar.exe' : 'kokoro-sidecar';
    return { command: path.join(this.getSidecarDir(), executable), args: [] };
  }

  getDefaultModelDir() {
    return path.join(this.projectRoot, 'models', 'Kokoro-82M-v1.1-zh', 'runtime');
  }

  getAssets() {
    const dir = process.env.KOKORO_MODEL_DIR || this.getModelRoot();
    return {
      model: process.env.KOKORO_MODEL_PATH || fs.readdirSync(dir).find(name => /^kokoro-v1\.1-zh\.(?:int8|fp16)\.onnx$/.test(name)) && path.join(dir, fs.readdirSync(dir).find(name => /^kokoro-v1\.1-zh\.(?:int8|fp16)\.onnx$/.test(name))),
      voices: process.env.KOKORO_VOICES_PATH || path.join(dir, 'voices-v1.1-zh.bin'),
      config: process.env.KOKORO_CONFIG_PATH || path.join(dir, 'config.json'),
    };
  }

  async start() {
    if (this.ready) return this.ready;

    this.ready = (async () => {
      const assets = this.getAssets();
      for (const key of ['model', 'voices']) {
        if (!fs.existsSync(assets[key])) throw new Error('Kokoro asset missing: ' + key + '=' + assets[key]);
      }
      const executable = this.getExecutable();
      const args = [
        ...executable.args,
        '--host', this.host,
        '--port', String(this.port),
        '--model', assets.model,
        '--voices', assets.voices,
      ];
      if (fs.existsSync(assets.config)) args.push('--config', assets.config);

      this.process = spawn(executable.command, args, {
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
