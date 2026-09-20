#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.KOKORO_SMOKE_PORT || 17862);
const sidecarDir = path.join(root, 'build', 'sidecar', 'kokoro-sidecar');
const modelDir = path.join(root, 'build', 'models', 'Kokoro-82M-v1.1-zh', 'int8');
const executable = process.platform === 'win32'
  ? path.join(sidecarDir, 'kokoro-sidecar.exe')
  : path.join(sidecarDir, 'kokoro-sidecar');

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      } : undefined,
      timeout: 5000,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(timeoutMs = 120000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await request('GET', '/health');
      if (response.status === 200) return JSON.parse(response.body.toString('utf8'));
      lastError = new Error('health status ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Packaged sidecar health timeout: ' + (lastError?.message || 'unknown error'));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function main() {
  const model = path.join(modelDir, 'kokoro-v1.1-zh.int8.onnx');
  const voices = path.join(modelDir, 'voices-v1.1-zh.bin');
  for (const file of [executable, model, voices]) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      throw new Error('Missing packaged runtime asset: ' + file);
    }
  }

  console.log('Starting packaged sidecar:', executable);
  const child = spawn(executable, [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--model', model,
    '--voices', voices,
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let logs = '';
  child.stdout.on('data', data => {
    const text = data.toString();
    logs += text;
    process.stdout.write('[sidecar] ' + text);
  });
  child.stderr.on('data', data => {
    const text = data.toString();
    logs += text;
    process.stderr.write('[sidecar:err] ' + text);
  });

  try {
    const health = await waitForHealth();
    console.log('health:', JSON.stringify(health));

    const voicesResponse = await request('GET', '/v1/voices');
    if (voicesResponse.status !== 200) {
      throw new Error('voice enumeration failed: HTTP ' + voicesResponse.status);
    }
    const voicesPayload = JSON.parse(voicesResponse.body.toString('utf8'));
    const voicesList = Array.isArray(voicesPayload) ? voicesPayload : voicesPayload.voices;
    if (!Array.isArray(voicesList) || voicesList.length === 0) {
      throw new Error('packaged sidecar returned no voices');
    }

    const voice = voicesList.includes('zf_001') ? 'zf_001' : voicesList[0];
    console.log('voices:', voicesList.length, 'test voice:', voice);

    const synthesis = await request('POST', '/v1/audio/speech', {
      input: '这是跨平台 PyInstaller 打包后的 Kokoro v1.1 中文端到端冒烟测试。',
      voice,
      speed: 1.0,
    });

    if (synthesis.status !== 200) {
      throw new Error(
        'synthesis failed: HTTP ' + synthesis.status + '\\n' + synthesis.body.toString('utf8') +
        '\\n' + logs
      );
    }

    const wav = synthesis.body;
    if (
      wav.length < 44 ||
      wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new Error('packaged sidecar returned an invalid WAV payload');
    }

    console.log('PACKAGED_SIDECAR_SMOKE_TEST: PASS; WAV bytes=', wav.length);
  } finally {
    await stopProcess(child);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
