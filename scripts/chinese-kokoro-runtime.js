const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');

const requireFromHere = createRequire(__filename);

const HF_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_DTYPE = 'q8';
const MAX_SYNTHESIS_TEXT = 300;
const HF_ENDPOINT = process.env.KOKORO_HF_ENDPOINT || 'https://hf-mirror.com';

const CHINESE_VOICES = [
  'zf_xiaoxiao',
  'zf_xiaobei',
  'zf_xiaoni',
  'zf_xiaoyi',
  'zm_yunjian',
  'zm_yunxi',
  'zm_yunxia',
  'zm_yunyang',
];

const VOICE_FILES = CHINESE_VOICES.map(voice => `${voice}.bin`);

function packageDir() {
  return path.dirname(requireFromHere.resolve('kokoro-js-zh'));
}

function voiceDir() {
  return path.join(packageDir(), 'voices');
}

function modelDir() {
  const configured = process.env.KOKORO_MODEL_DIR;
  if (configured) return configured;
  return path.join(os.homedir(), '.cache', 'domekokoro', 'models', 'kokoro');
}

function localModelAvailable() {
  const dir = modelDir();
  if (!fs.existsSync(dir)) return false;
  const names = fs.readdirSync(dir);
  return names.some(name => name.endsWith('.onnx')) ||
    (fs.existsSync(path.join(dir, 'onnx')) &&
      fs.readdirSync(path.join(dir, 'onnx')).some(name => name.endsWith('.onnx')));
}

function voicesReady() {
  const dir = voiceDir();
  return VOICE_FILES.every(file => fs.existsSync(path.join(dir, file)));
}

async function downloadFile(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, data);
}

async function ensureVoices() {
  const dir = voiceDir();
  fs.mkdirSync(dir, { recursive: true });

  for (const file of VOICE_FILES) {
    const destination = path.join(dir, file);
    if (fs.existsSync(destination) && fs.statSync(destination).size > 0) continue;

    const url = `${HF_ENDPOINT}/${HF_MODEL_ID}/resolve/main/voices/${file}`;
    await downloadFile(url, destination);
  }
}

async function ensureEspeakWasm() {
  const target = path.join(packageDir(), 'dist', 'espeak-ng.wasm');
  if (fs.existsSync(target)) return;

  const espeakPackage = requireFromHere.resolve('espeak-ng/package.json');
  const source = path.join(path.dirname(espeakPackage), 'dist', 'espeak-ng.wasm');
  if (!fs.existsSync(source)) {
    throw new Error('espeak-ng.wasm is missing from espeak-ng package');
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

class ChineseKokoroRuntime {
  constructor() {
    this.tts = null;
    this.loading = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.tts) return this.tts;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      await ensureEspeakWasm();
      await ensureVoices();

      const { env } = await import('@huggingface/transformers');
      env.remoteHost = HF_ENDPOINT;

      const { KokoroTTS } = await import('kokoro-js-zh');
      const tts = await KokoroTTS.from_pretrained(HF_MODEL_ID, {
        dtype: KOKORO_DTYPE,
        device: 'cpu',
      });

      this.tts = tts;
      return tts;
    })();

    try {
      return await this.loading;
    } catch (error) {
      this.loading = null;
      this.tts = null;
      throw error;
    }
  }

  generateAudio(text, voice = 'zf_xiaoxiao') {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) return Promise.reject(new Error('TTS text is empty'));
    if (normalized.length > MAX_SYNTHESIS_TEXT) {
      return Promise.reject(
        new Error(`TTS text is too long (maximum ${MAX_SYNTHESIS_TEXT} characters per synthesis)`)
      );
    }
    if (!CHINESE_VOICES.includes(voice)) {
      return Promise.reject(new Error(`Unsupported Chinese Kokoro voice: ${voice}`));
    }

    const run = this.queue.then(async () => {
      const tts = await this.load();
      return tts.generate(normalized, { voice });
    });

    this.queue = run.catch(() => undefined);
    return run;
  }

  async synthesizeWav(text, voice) {
    const audio = await this.generateAudio(text, voice);
    return Buffer.from(await audio.toWav());
  }

  getVoices() {
    return [...CHINESE_VOICES];
  }

  getConfig() {
    return {
      modelId: HF_MODEL_ID,
      dtype: KOKORO_DTYPE,
      device: 'cpu',
      maxSynthesisText: MAX_SYNTHESIS_TEXT,
      synthesisMode: 'serialized-single-instance',
      endpoint: HF_ENDPOINT,
      localModelDir: modelDir(),
      localModelAvailable: localModelAvailable(),
      voicesReady: voicesReady(),
    };
  }

  clearCache() {
    this.tts = null;
  }
}

const chineseKokoroRuntime = new ChineseKokoroRuntime();

module.exports = {
  ChineseKokoroRuntime,
  chineseKokoroRuntime,
  HF_MODEL_ID,
  KOKORO_DTYPE,
  MAX_SYNTHESIS_TEXT,
  CHINESE_VOICES,
};
