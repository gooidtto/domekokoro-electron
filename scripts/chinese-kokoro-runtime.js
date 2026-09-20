const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');

const requireFromHere = createRequire(__filename);

const REMOTE_MODEL_ID = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX';
const DEFAULT_MODEL_NAME = 'Kokoro-82M-v1.1-zh-ONNX';
const KOKORO_DTYPE = 'q8';
const MAX_SYNTHESIS_TEXT = 300;
const HF_ENDPOINT = process.env.KOKORO_HF_ENDPOINT || 'https://hf-mirror.com';

// Kokoro-82M-v1.1-zh-ONNX currently registers 103 voices:
// 3 English voices + 100 Chinese voices. Local voice discovery remains
// authoritative; this list is only used for remote fallback/downloads.
const CHINESE_VOICES = [
  'af_maple', 'af_sol', 'bf_vale',
  'zf_001', 'zf_002', 'zf_003', 'zf_004', 'zf_005', 'zf_006', 'zf_007', 'zf_008',
  'zf_017', 'zf_018', 'zf_019', 'zf_021', 'zf_022', 'zf_023', 'zf_024', 'zf_026',
  'zf_027', 'zf_028', 'zf_032', 'zf_036', 'zf_038', 'zf_039', 'zf_040', 'zf_042',
  'zf_043', 'zf_044', 'zf_046', 'zf_047', 'zf_048', 'zf_049', 'zf_051', 'zf_059',
  'zf_060', 'zf_067', 'zf_070', 'zf_071', 'zf_072', 'zf_073', 'zf_074', 'zf_075',
  'zf_076', 'zf_077', 'zf_078', 'zf_079', 'zf_083', 'zf_084', 'zf_085', 'zf_086',
  'zf_087', 'zf_088', 'zf_090', 'zf_092', 'zf_093', 'zf_094', 'zf_099',
  'zm_009', 'zm_010', 'zm_011', 'zm_012', 'zm_013', 'zm_014', 'zm_015', 'zm_016',
  'zm_020', 'zm_025', 'zm_029', 'zm_030', 'zm_031', 'zm_033', 'zm_034', 'zm_035',
  'zm_037', 'zm_041', 'zm_045', 'zm_050', 'zm_052', 'zm_053', 'zm_054', 'zm_055',
  'zm_056', 'zm_057', 'zm_058', 'zm_061', 'zm_062', 'zm_063', 'zm_064', 'zm_065',
  'zm_066', 'zm_068', 'zm_069', 'zm_080', 'zm_081', 'zm_082', 'zm_089', 'zm_091',
  'zm_095', 'zm_096', 'zm_097', 'zm_098', 'zm_100',
];

const VOICE_FILES = CHINESE_VOICES.map(voice => `${voice}.bin`);
const LOCAL_MODEL_FILENAMES = [
  'onnx/model_int8.onnx',
  'onnx/model_quantized.onnx',
  'onnx/model_fp16.onnx',
  'onnx/model.onnx',
  'kokoro-v1.1-zh.int8.onnx',
  'kokoro-v1.0.int8.onnx',
];

function packageDir() {
  return path.dirname(requireFromHere.resolve('kokoro-js-zh'));
}

function voiceDir() {
  return process.env.KOKORO_VOICES_DIR
    ? path.resolve(process.env.KOKORO_VOICES_DIR)
    : path.join(modelDir(), 'voices');
}

function modelDir() {
  const configured = process.env.KOKORO_MODEL_DIR;
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), 'models', DEFAULT_MODEL_NAME);
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
    voices: listLocalVoices(),
    ready: Boolean(modelFile && fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'tokenizer.json'))),
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

      const { env } = await import('@huggingface/transformers');
      env.remoteHost = HF_ENDPOINT;

      let modelSource = REMOTE_MODEL_ID;
      if (localModelRequested()) {
        const status = ensureLocalModelIsUsable();
        modelSource = status.dir;
        env.allowLocalModels = true;
        env.localModelPath = path.dirname(status.dir);
        env.allowRemoteModels = process.env.KOKORO_ALLOW_REMOTE_FALLBACK === '1';
        if (!voicesReady()) {
          throw new Error(`Local Kokoro model has no voice .bin files in ${voiceDir()}`);
        }
        console.log('[kokoro-zh] using local model:', status.modelFile);
      } else {
        await ensureVoices();
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

  generateAudio(text, voice = 'zf_001') {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) return Promise.reject(new Error('TTS text is empty'));
    if (normalized.length > MAX_SYNTHESIS_TEXT) {
      return Promise.reject(
        new Error(`TTS text is too long (maximum ${MAX_SYNTHESIS_TEXT} characters per synthesis)`)
      );
    }
    const availableVoices = this.getVoices();
    if (!availableVoices.includes(voice)) {
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
    const localVoices = listLocalVoices();
    return localVoices.length ? localVoices : [...CHINESE_VOICES];
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
      localModelRequirements: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_int8.onnx (or another supported ONNX variant)', 'voices/*.bin (individual Transformers.js voice files; voices-v1.1-zh.bin is a separate kokoro-onnx bundle and is not consumed directly by kokoro-js-zh)'],
      voicesDir: voiceDir(),
      voicesReady: voicesReady(),
      availableVoices: this.getVoices(),
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
  return fs.existsSync(dir) && fs.readdirSync(dir).some(name => name.endsWith('.bin'));
}

function listLocalVoices() {
  const dir = voiceDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.bin')).map(name => name.slice(0, -4)).sort();
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
