const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');

const requireFromHere = createRequire(__filename);

const REMOTE_MODEL_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX';
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
const LOCAL_MODEL_FILENAMES = [
  'kokoro-v1.1-zh.int8.onnx',
  'kokoro-v1.0.int8.onnx',
  'onnx/model_int8.onnx',
  'onnx/model_quantized.onnx',
];

function packageDir() {
  return path.dirname(requireFromHere.resolve('kokoro-js-zh'));
}

function voiceDir() {
  return process.env.KOKORO_VOICES_DIR
    ? path.resolve(process.env.KOKORO_VOICES_DIR)
    : path.join(packageDir(), 'voices');
}

function modelDir() {
  const configured = process.env.KOKORO_MODEL_DIR;
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), 'models', 'kokoro-v1.1-zh');
}

function findLocalModelFile(dir = modelDir()) {
  for (const relative of LOCAL_MODEL_FILENAMES) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
      return candidate;
    }
  }
  return null;
}

function localModelAvailable() {
  const dir = modelDir();
  return Boolean(
    findLocalModelFile(dir) &&
    fs.existsSync(path.join(dir, 'config.json')) &&
    fs.existsSync(path.join(dir, 'tokenizer.json'))
  );
}

function localModelStatus() {
  const dir = modelDir();
  const modelFile = findLocalModelFile(dir);
  return {
    dir,
    modelFile,
    config: fs.existsSync(path.join(dir, 'config.json')),
    tokenizer: fs.existsSync(path.join(dir, 'tokenizer.json')),
    tokenizerConfig: fs.existsSync(path.join(dir, 'tokenizer_config.json')),
    ready: localModelAvailable(),
  };
}

function localModelRequested() {
  return process.env.KOKORO_USE_LOCAL_MODEL === '1' || localModelAvailable();
}

function ensureLocalModelIsUsable() {
  const status = localModelStatus();
  if (!status.modelFile) {
    throw new Error(
      `Local Kokoro model not found in ${status.dir}. Expected one of: ${LOCAL_MODEL_FILENAMES.join(', ')}`
    );
  }
  if (!status.config || !status.tokenizer) {
    throw new Error(
      'Local Kokoro model is incomplete. The ONNX file must be accompanied by config.json and tokenizer.json in the same model directory.'
    );
  }
  return status;
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

    const url = `${HF_ENDPOINT}/onnx-community/Kokoro-82M-v1.1-zh-ONNX/resolve/main/voices/${file}`;
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
    this.source = null;
  }

  async load() {
    if (this.tts) return this.tts;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      await ensureEspeakWasm();
      await ensureVoices();

      const { env } = await import('@huggingface/transformers');
      env.remoteHost = HF_ENDPOINT;

      let modelSource = REMOTE_MODEL_ID;
      if (localModelRequested()) {
        const status = ensureLocalModelIsUsable();
        modelSource = status.dir;
        env.allowLocalModels = true;
        env.localModelPath = path.dirname(status.dir);
        env.allowRemoteModels = process.env.KOKORO_ALLOW_REMOTE_FALLBACK === '1';
        console.log('[kokoro-zh] using local model:', status.modelFile);
      } else {
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
        console.log('[kokoro-zh] using remote model:', REMOTE_MODEL_ID);
      }

      const { KokoroTTS } = await import('kokoro-js-zh');
      const tts = await KokoroTTS.from_pretrained(modelSource, {
        dtype: KOKORO_DTYPE,
        device: 'cpu',
        voicePath: voiceDir(),
      });

      this.source = {
        mode: modelSource === REMOTE_MODEL_ID ? 'remote' : 'local',
        model: modelSource,
        modelFile: modelSource === REMOTE_MODEL_ID ? null : findLocalModelFile(modelSource),
      };
      this.tts = tts;
      return tts;
    })();

    try {
      return await this.loading;
    } catch (error) {
      this.loading = null;
      this.tts = null;
      this.source = null;
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
    const local = localModelStatus();
    return {
      modelId: REMOTE_MODEL_ID,
      dtype: KOKORO_DTYPE,
      device: 'cpu',
      maxSynthesisText: MAX_SYNTHESIS_TEXT,
      synthesisMode: 'serialized-single-instance',
      endpoint: HF_ENDPOINT,
      modelSourceMode: localModelRequested() ? 'local-first' : 'remote',
      localModelDir: local.dir,
      localModelFile: local.modelFile,
      localModelAvailable: local.ready,
      localModelRequirements: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx model'],
      voicesDir: voiceDir(),
      voicesReady: voicesReady(),
      loadedSource: this.source,
    };
  }

  clearCache() {
    this.tts = null;
    this.source = null;
  }
}

function voicesReady() {
  const dir = voiceDir();
  return VOICE_FILES.every(file => fs.existsSync(path.join(dir, file)));
}

const chineseKokoroRuntime = new ChineseKokoroRuntime();

module.exports = {
  ChineseKokoroRuntime,
  chineseKokoroRuntime,
  REMOTE_MODEL_ID,
  KOKORO_DTYPE,
  MAX_SYNTHESIS_TEXT,
  CHINESE_VOICES,
  modelDir,
  findLocalModelFile,
  localModelAvailable,
};
