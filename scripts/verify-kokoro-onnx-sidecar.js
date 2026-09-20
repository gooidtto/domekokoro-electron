#!/usr/bin/env node
const { KokoroServiceManager } = require('./sidecar/kokoro-service-manager');
const api = require('./sidecar/kokoro-api-client');

async function main() {
  const manager = new KokoroServiceManager();
  try {
    const health = await manager.start();
    console.log(JSON.stringify(health, null, 2));

    if (process.argv.includes('--health-only')) return;

    const voices = await api.listVoices({ port: manager.port });
    if (!Array.isArray(voices) || voices.length === 0) {
      throw new Error('Sidecar returned no voices');
    }

    console.log('voices:', voices.length);
    console.log('first voices:', voices.slice(0, 10).join(', '));

    const wav = await api.synthesize({
      text: '这是 Phase 2 的本地 Kokoro v1.1 中文运行时验证。',
      voice: voices.includes('zf_001') ? 'zf_001' : voices[0],
      port: manager.port,
    });

    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Sidecar returned an invalid WAV payload');
    }

    console.log('synthesis: WAV OK, bytes=', wav.length);
  } finally {
    manager.stop();
  }
}

main().catch(err => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
