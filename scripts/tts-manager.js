const { KokoroTTS } = require('kokoro-js');

/**
 * DomeKokoro Runtime v1 baseline
 *
 * Derived from DomeAI V10.7 local Kokoro runtime fixes:
 * - single cached model instance
 * - serialized inference queue to prevent native-memory peak stacking
 * - 300-character per-request guardrail
 *
 * The original V10.7 Docker/Next.js fixes are documented separately because
 * this Electron runtime has no Docker Compose build-arg layer or Next.js webpack
 * server bundle.
 */
const FIXED_MODEL_ID = 'onnx-community/Kokoro-82M-ONNX';
const FIXED_DTYPE = 'fp16';
const MAX_SYNTHESIS_TEXT = 300;

class TTSManager {
  constructor() {
    this.cachedTTS = null;
    this.modelId = FIXED_MODEL_ID;
    this.dtype = FIXED_DTYPE;
    this.synthesisQueue = Promise.resolve();
  }

  async loadTTS() {
    if (!this.cachedTTS) {
      this.cachedTTS = await KokoroTTS.from_pretrained(this.modelId, {
        dtype: this.dtype,
      });
    }
    return this.cachedTTS;
  }

  async initialize(onProgress) {
    try {
      onProgress?.('Initializing TTS system...');
      await this.loadTTS();
      onProgress?.('TTS system ready!');
      return true;
    } catch (err) {
      console.error('Kokoro init failed:', err);
      onProgress?.('Failed to initialize TTS system.');
      return false;
    }
  }

  async getVoices() {
    try {
      const tts = await this.loadTTS();
      return tts.voices || [];
    } catch (err) {
      console.error('Voice listing failed:', err);
      return [];
    }
  }

  /**
   * Serialize all batch inference through one native ONNX execution.
   * The V10.7 production fix showed that parallel Kokoro instances can
   * multiply native memory peaks and trigger swap/OOM on low-memory hosts.
   */
  generateAudio(text, voice) {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) {
      return Promise.reject(new Error('TTS text is empty'));
    }
    if (normalized.length > MAX_SYNTHESIS_TEXT) {
      return Promise.reject(
        new Error(`TTS text is too long (maximum ${MAX_SYNTHESIS_TEXT} characters per synthesis)`)
      );
    }

    const run = this.synthesisQueue.then(async () => {
      const tts = await this.loadTTS();
      return tts.generate(normalized, { voice });
    });

    // Keep the queue alive after a failed request.
    this.synthesisQueue = run.catch(() => undefined);
    return run;
  }

  async generateAudioBuffer(text, voice) {
    const audio = await this.generateAudio(text, voice);
    return Buffer.from(await audio.toWav());
  }

  /**
   * Kept for API compatibility. Runtime v1 deliberately does not create
   * additional model instances: doing so defeats memory serialization.
   */
  async createNewInstance() {
    return this.loadTTS();
  }

  async generatePreview(voice, previewText = 'This is a sample of the selected voice.') {
    return this.generateAudio(previewText, voice);
  }

  clearCache() {
    this.cachedTTS = null;
  }

  getConfig() {
    return {
      modelId: this.modelId,
      dtype: this.dtype,
      maxSynthesisText: MAX_SYNTHESIS_TEXT,
      synthesisMode: 'serialized-single-instance',
    };
  }

  updateConfig(modelId, dtype) {
    if (modelId) this.modelId = modelId;
    if (dtype) this.dtype = dtype;
    this.clearCache();
  }
}

const ttsManager = new TTSManager();

module.exports = {
  TTSManager,
  ttsManager,
  FIXED_MODEL_ID,
  FIXED_DTYPE,
  MAX_SYNTHESIS_TEXT,
};
