const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Now safe to import electron and other modules
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const BACKEND_PORT = Number(process.env.DOMEKOKORO_PORT || 18451);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
let backendProcess = null;
let backendStarting = null;

async function ensureLocalBackend() {
  if (backendStarting) return backendStarting;
  backendStarting = (async () => {
    const http = require('http');
    const health = () => new Promise(resolve => {
      const req = http.get(BACKEND_URL + '/api/v1/health', res => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1200, () => { req.destroy(); resolve(false); });
    });
    if (await health()) return true;

    const backendPath = path.join(__dirname, 'backend', 'server.cjs');
    backendProcess = spawn(process.execPath, [backendPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DOMEKOKORO_PORT: String(BACKEND_PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    backendProcess.stdout.on('data', d => console.log('[DomeKokoro backend]', d.toString().trim()));
    backendProcess.stderr.on('data', d => console.error('[DomeKokoro backend]', d.toString().trim()));

    const startedAt = Date.now();
    while (Date.now() - startedAt < 10000) {
      if (await health()) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('DomeKokoro local TTS backend did not start on ' + BACKEND_URL);
  })().finally(() => { backendStarting = null; });
  return backendStarting;
}

async function backendRequest(method, pathname, body = null) {
  await ensureLocalBackend();
  const { request } = require('http');
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(BACKEND_URL + pathname, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'X-BookNote-Client': 'BookNote' } : {},
      timeout: 120000
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400) reject(new Error(data.error || 'Backend request failed'));
          else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Backend request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}


// Import extracted utility modules
const { isValidTextFile, getFileSize, readTextFile } = require('./scripts/file-utils');
const {
  splitText,
  tokenizeText,
  estimateProcessingTime,
  normalizeForTTS,
} = require('./scripts/text-utils');
const { mergeWavBuffers } = require('./scripts/audio-utils');
const { createSettingsManager } = require('./scripts/settings-manager');

// Initialize settings manager
const settingsManager = createSettingsManager({
  defaults: {
    lastModel: '',
    lastText: '',
    windowBounds: { width: 800, height: 600, x: undefined, y: undefined },
  },
});

function createWindow() {
  const winBounds = settingsManager.getWindowBounds({ width: 500, height: 500 });
  const win = new BrowserWindow({
    ...winBounds,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('index.html');

  // DevTools disabled in production

  // Save size and position on close
  win.on('close', () => {
    settingsManager.saveWindowBounds(win.getBounds());
  });
}

app.whenReady().then(createWindow);

ipcMain.handle('choose-output-file', async () => {
  const result = await dialog.showSaveDialog({
    title: 'Save Output Audio',
    defaultPath: 'kokoro-output.wav',
    filters: [{ name: 'WAV files', extensions: ['wav'] }],
  });

  if (!result.canceled && result.filePath) {
    settingsManager.set('lastOutput', result.filePath);
    return result.filePath;
  }
});

ipcMain.handle('initialize-kokoro', async event => {
  const onProgress = message => {
    event.sender.send('kokoro-init-progress', { message });
  };

  return await ttsManager.initialize(onProgress);
});

ipcMain.handle('list-kokoro-voices', async () => {
  return await ttsManager.getVoices();
});

const defaultOutputPath = path.join(app.getPath('documents'), 'kokoro-output.wav');

ipcMain.handle('run-kokoro', async (_event, text, outFile, voice) => {
  const result = await backendRequest('POST', '/api/v1/synthesize', {
    text,
    voice,
    continuous: true,
    timing: false
  });
  if (!outFile || !outFile.trim()) outFile = defaultOutputPath;
  fs.writeFileSync(outFile, Buffer.from(result.audioBase64, 'base64'));
  settingsManager.saveSessionState(text, voice, outFile);
  return outFile;
});

ipcMain.handle('run-kokoro-multi', async (_event, text, outFile, voice) => {
  const result = await backendRequest('POST', '/api/v1/synthesize', {
    text,
    voice,
    continuous: true,
    timing: false
  });
  if (!outFile || !outFile.trim()) outFile = defaultOutputPath;
  fs.writeFileSync(outFile, Buffer.from(result.audioBase64, 'base64'));
  settingsManager.saveSessionState(text, voice, outFile);
  return outFile;
});

ipcMain.handle('preview-voice', async (_event, voice) => {
  const result = await backendRequest('POST', '/api/v1/synthesize', {
    text: '这是所选声音的试听。',
    voice,
    continuous: false,
    timing: false
  });
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'domekokoro-preview-'), { mode: 0o700 });
  const outputFile = path.join(tmpdir, `preview-${crypto.randomUUID()}.wav`);
  fs.writeFileSync(outputFile, Buffer.from(result.audioBase64, 'base64'), { mode: 0o600 });
  settingsManager.set('lastModel', voice);
  return outputFile;
});

ipcMain.handle('get-last-settings', async () => {
  return settingsManager.getLastSettings();
});

ipcMain.handle('reset-settings', async () => {
  settingsManager.clear();
});

ipcMain.handle('read-text-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Text File',
    // filters: [{ name: 'Text Files', extensions: ['txt'] }],
    filters: [{ name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) {
    return null;
  }

  const filePath = filePaths[0];

  if (!isValidTextFile(filePath)) {
    return { invalid: true, path: filePath };
  }

  const fileSize = getFileSize(filePath);
  if (!fileSize || fileSize > 1024 * 1024) {
    return { tooLarge: true, path: filePath };
  } // >1MB

  const text = readTextFile(filePath);
  if (!text) {
    return { error: true, path: filePath };
  }

  return { text, path: filePath };
});

ipcMain.handle('speak-text-file', async (_event, filePath, _modelPath, outputPath) => {
  const text = fs.readFileSync(filePath, 'utf8');
  const result = await backendRequest('POST', '/api/v1/synthesize', {
    text,
    voice: settingsManager.get('lastModel', 'zf_001'),
    continuous: true,
    timing: false
  });
  fs.writeFileSync(outputPath, Buffer.from(result.audioBase64, 'base64'));
  return outputPath;
});

ipcMain.handle('validate-file-for-drag-drop', async (_, file) => {
  // Use the same validation logic as read-text-file
  if (!isValidTextFile(file)) {
    return { valid: false, reason: 'Invalid file type' };
  }

  // You could also check size here if needed
  return { valid: true };
});

ipcMain.handle('start-kokoro-stream', async (event, text, voice, outputPath) => {
  try {
    const result = await backendRequest('POST', '/api/v1/synthesize', { text, voice, continuous: true, timing: false });
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'domekokoro-stream-'), { mode: 0o700 });
    const finalPath = outputPath || path.join(tmpdir, `stream-${crypto.randomUUID()}.wav`);
    const audio = Buffer.from(result.audioBase64, 'base64');
    fs.writeFileSync(finalPath, audio, { mode: 0o600 });
    event.sender.send('kokoro-chunk-ready', finalPath);
    event.sender.send('kokoro-complete', finalPath);
  } catch (err) {
    event.sender.send('kokoro-error', 'Kokoro error: ' + err.message);
    throw err;
  }
});
