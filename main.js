const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const {
  splitText,
  estimateProcessingTime,
  normalizeForTTS,
} = require('./scripts/text-utils');
const { mergeWavBuffers } = require('./scripts/audio-utils');
const { createSettingsManager } = require('./scripts/settings-manager');
const { KokoroServiceManager } = require('./scripts/sidecar/kokoro-service-manager');
const kokoroApi = require('./scripts/sidecar/kokoro-api-client');

const settingsManager = createSettingsManager({
  defaults: {
    lastModel: '',
    lastText: '',
    windowBounds: { width: 800, height: 600, x: undefined, y: undefined },
  },
});

const kokoroService = new KokoroServiceManager();

function createWindow() {
  const winBounds = settingsManager.getWindowBounds({ width: 500, height: 500 });
  const win = new BrowserWindow({
    ...winBounds,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  win.on('close', () => settingsManager.saveWindowBounds(win.getBounds()));
}

async function ensureKokoroReady() {
  await kokoroService.start();
  return kokoroApi.health({ port: kokoroService.port });
}

app.whenReady().then(async () => {
  try {
    await ensureKokoroReady();
    console.log('[kokoro] sidecar ready');
  } catch (err) {
    console.error('[kokoro] sidecar startup failed:', err);
  }
  createWindow();
});

app.on('before-quit', () => kokoroService.stop());

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
  try {
    event.sender.send('kokoro-init-progress', { message: 'Starting Kokoro v1.1-zh sidecar...' });
    const health = await ensureKokoroReady();
    event.sender.send('kokoro-init-progress', { message: 'Kokoro v1.1-zh ready.' });
    return health;
  } catch (err) {
    console.error('Kokoro sidecar init failed:', err);
    event.sender.send('kokoro-init-progress', { message: 'Failed to start Kokoro sidecar.' });
    throw err;
  }
});

ipcMain.handle('list-kokoro-voices', async () => {
  await ensureKokoroReady();
  return kokoroApi.listVoices({ port: kokoroService.port });
});

ipcMain.handle('get-kokoro-config', async () => {
  await ensureKokoroReady();
  return kokoroApi.health({ port: kokoroService.port });
});

ipcMain.handle('run-kokoro', async (_event, text, outFile, voice) => {
  try {
    await ensureKokoroReady();
    const normalizedText = normalizeForTTS(text);
    const wav = await kokoroApi.synthesize({
      text: normalizedText,
      voice: voice || 'zf_001',
      port: kokoroService.port,
    });
    if (!outFile || !outFile.trim()) {
      outFile = path.join(app.getPath('documents'), 'kokoro-output.wav');
    }
    fs.writeFileSync(outFile, wav);
    settingsManager.saveSessionState(text, voice, outFile);
    return outFile;
  } catch (err) {
    console.error('Kokoro generation failed:', err);
    throw new Error('Kokoro error: ' + err.message, { cause: err });
  }
});

ipcMain.handle('run-kokoro-multi', async (event, text, outFile, voice) => {
  const chunks = await splitText(text, 300);
  const results = [];
  const estimatedMs = estimateProcessingTime(text, 50, 1000);
  let progress = 0;
  const progressInterval = setInterval(() => {
    progress = Math.min(95, progress + Math.random() * 8 + 2);
    event.sender.send('kokoro-progress-update', {
      progress: Math.floor(progress),
      text: `Processing... ${Math.floor(progress)}%`,
    });
  }, Math.max(100, estimatedMs / 20));

  try {
    await ensureKokoroReady();
    for (const chunk of chunks) {
      const normalizedChunk = normalizeForTTS(chunk);
      if (!normalizedChunk) continue;
      const wav = await kokoroApi.synthesize({
        text: normalizedChunk,
        voice: voice || 'zf_001',
        port: kokoroService.port,
      });
      results.push(wav);
    }
    if (!results.length) throw new Error('No non-empty text chunks to synthesize.');
    const merged = mergeWavBuffers(results);
    if (!outFile || !outFile.trim()) {
      outFile = path.join(app.getPath('documents'), 'kokoro-output.wav');
    }
    fs.writeFileSync(outFile, merged);
    settingsManager.saveSessionState(text, voice, outFile);
    event.sender.send('kokoro-progress-update', { progress: 100, text: 'Complete' });
    return outFile;
  } finally {
    clearInterval(progressInterval);
  }
});

ipcMain.handle('preview-voice', async (_event, voice) => {
  await ensureKokoroReady();
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-preview-'), { mode: 0o700 });
  const outputFile = path.join(tmpdir, `kokoro-voice-preview-${crypto.randomUUID()}.wav`);
  const wav = await kokoroApi.synthesize({
    text: '这是所选中文声音的试听。',
    voice: voice || 'zf_001',
    port: kokoroService.port,
  });
  fs.writeFileSync(outputFile, wav, { mode: 0o600 });
  settingsManager.set('lastModel', voice || 'zf_001');
  return outputFile;
});

ipcMain.handle('get-last-settings', async () => settingsManager.getLastSettings());
ipcMain.handle('reset-settings', async () => settingsManager.clear());

ipcMain.handle('read-text-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Text File',
    filters: [{ name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  const filePath = filePaths[0];
  const { isValidTextFile, getFileSize, readTextFile } = require('./scripts/file-utils');
  if (!isValidTextFile(filePath)) return { invalid: true, path: filePath };
  const fileSize = getFileSize(filePath);
  if (!fileSize || fileSize > 1024 * 1024) return { tooLarge: true, path: filePath };
  const text = readTextFile(filePath);
  if (!text) return { error: true, path: filePath };
  return { text, path: filePath };
});

ipcMain.handle('speak-text-file', async (_, filePath, modelPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const piperPath = settingsManager.get('piperPath');
    const child = spawn(piperPath, ['--model', modelPath, '--output_file', outputPath]);
    fs.createReadStream(filePath).pipe(child.stdin);
    child.on('exit', code => code === 0 ? resolve(outputPath) : reject(new Error(`Piper exited with code ${code}`)));
  });
});

ipcMain.handle('validate-file-for-drag-drop', async (_, file) => {
  const { isValidTextFile } = require('./scripts/file-utils');
  return isValidTextFile(file) ? { valid: true } : { valid: false, reason: 'Invalid file type' };
});

// Streaming is intentionally not part of Phase 2. Keep the IPC surface explicit.
ipcMain.handle('start-kokoro-stream', async () => {
  throw new Error('Kokoro streaming is deferred until the sidecar batch path is validated.');
});
ipcMain.handle('cancel-kokoro-stream', async () => false);
