const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.DOMEKOKORO_PORT || 18451);
const SERVICE = 'domekokoro-tts';
const API_VERSION = '1';
const DEFAULT_VOICE = process.env.DOMEKOKORO_VOICE || 'zf_001';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
    'Access-Control-Allow-Headers': 'Content-Type, X-BookNote-Client',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error('Request body exceeds 2MB'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function modelConfig() {
  const root = process.env.DOMEKOKORO_MODEL_DIR || path.join(os.homedir(), '.cache', 'domekokoro', 'models');
  return {
    root,
    modelPath: process.env.DOMEKOKORO_MODEL_PATH || path.join(root, 'kokoro-v1.1-zh.int8.onnx'),
    voicesPath: process.env.DOMEKOKORO_VOICES_PATH || path.join(root, 'voices-v1.1-zh.bin'),
    configPath: process.env.DOMEKOKORO_CONFIG_PATH || path.join(root, 'config.json')
  };
}

function pythonCandidates() {
  if (process.env.DOMEKOKORO_PYTHON) return [process.env.DOMEKOKORO_PYTHON];
  return process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
}

function findPython() {
  return new Promise(resolve => {
    const candidates = pythonCandidates();
    let index = 0;
    function next() {
      if (index >= candidates.length) return resolve(null);
      const cmd = candidates[index++];
      const child = spawn(cmd, ['-c', 'import sys; print(sys.executable)'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.on('error', next);
      child.on('close', code => code === 0 && output.trim() ? resolve(output.trim()) : next());
    }
    next();
  });
}

let worker;
let workerStarting;
let callWorker;

async function ensureWorker() {
  if (worker && callWorker) return;
  if (workerStarting) return workerStarting;
  workerStarting = (async () => {
    const python = await findPython();
    if (!python) throw new Error('Python 3.10-3.13 is required for the local kokoro-onnx backend.');

    const cfg = modelConfig();
    if (!fs.existsSync(cfg.modelPath) || !fs.existsSync(cfg.voicesPath)) {
      throw new Error('Kokoro model files are missing.');
    }

    const workerPath = path.join(__dirname, 'worker.py');
    worker = spawn(python, [workerPath], {
      env: {
        ...process.env,
        DOMEKOKORO_MODEL_PATH: cfg.modelPath,
        DOMEKOKORO_VOICES_PATH: cfg.voicesPath,
        DOMEKOKORO_CONFIG_PATH: cfg.configPath
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    worker.stderr.on('data', d => process.stderr.write('[kokoro-worker] ' + d.toString()));

    let buffer = '';
    const pending = new Map();

    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      buffer += chunk;
      let lineEnd;
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const resolver = pending.get(msg.id);
          if (!resolver) continue;
          pending.delete(msg.id);
          resolver(msg);
        } catch (error) {
          process.stderr.write('[kokoro-worker] invalid message: ' + error.message + '\n');
        }
      }
    });

    worker.on('exit', () => {
      for (const [, pendingRequest] of pending) pendingRequest({ ok: false, error: 'worker exited' });
      pending.clear();
      worker = undefined;
      callWorker = undefined;
    });

    callWorker = payload => new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('TTS backend timeout'));
      }, 120000);
      pending.set(id, message => {
        clearTimeout(timer);
        if (message.ok) resolve(message);
        else reject(new Error(message.error || 'TTS backend error'));
      });
      worker.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });

    await callWorker({ op: 'ping' });
  })().finally(() => { workerStarting = undefined; });
  return workerStarting;
}

function health() {
  const cfg = modelConfig();
  return {
    service: SERVICE,
    apiVersion: API_VERSION,
    engine: 'kokoro-onnx',
    status: callWorker ? 'ready' : 'offline',
    endpoint: 'http://' + HOST + ':' + PORT,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    model: { exists: fs.existsSync(cfg.modelPath), path: cfg.modelPath },
    voices: { exists: fs.existsSync(cfg.voicesPath), path: cfg.voicesPath },
    capabilities: ['synthesize', 'stream', 'voices', 'timing'],
    booknote: { discoverable: true, protocol: 'loopback-fixed-port', port: PORT }
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
      'Access-Control-Allow-Headers': 'Content-Type, X-BookNote-Client',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/api/v1/health') {
      json(res, 200, health());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/voices') {
      await ensureWorker();
      json(res, 200, await callWorker({ op: 'voices' }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/synthesize') {
      const input = JSON.parse((await readBody(req)) || '{}');
      if (!input.text || typeof input.text !== 'string') {
        json(res, 400, { error: 'text is required' });
        return;
      }
      await ensureWorker();
      json(res, 200, await callWorker({
        op: 'synthesize',
        text: input.text,
        voice: input.voice || DEFAULT_VOICE,
        speed: Number(input.speed || 1),
        continuous: input.continuous !== false,
        timing: Boolean(input.timing)
      }));
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, 503, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('Dome Kokoro TTS backend listening on http://' + HOST + ':' + PORT);
});
