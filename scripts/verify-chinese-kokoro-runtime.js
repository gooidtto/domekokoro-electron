const fs = require('fs');
const path = require('path');
const os = require('os');

const { chineseKokoroRuntime, CHINESE_VOICES } = require('../scripts/chinese-kokoro-runtime');

function validateWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('WAV buffer is empty or too small');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Generated audio is not a RIFF/WAVE file');
  }

  const dataOffset = buffer.indexOf(Buffer.from('data'));
  if (dataOffset < 0 || dataOffset + 8 > buffer.length) {
    throw new Error('WAV data chunk is missing');
  }

  const dataSize = buffer.readUInt32LE(dataOffset + 4);
  if (dataSize <= 0) {
    throw new Error('WAV data chunk is empty');
  }

  return { bytes: buffer.length, dataBytes: dataSize };
}

async function main() {
  const count = Number(process.env.KOKORO_V1_TEST_COUNT || 1);
  const voice = process.env.KOKORO_V1_TEST_VOICE || CHINESE_VOICES[0];
  const text = process.env.KOKORO_V1_TEST_TEXT || '你好，这是 DomeKokoro Runtime v1 的中文语音测试。';

  console.log('[runtime-v1] voices:', CHINESE_VOICES.join(', '));
  console.log('[runtime-v1] config:', chineseKokoroRuntime.getConfig());

  const before = process.memoryUsage().rss;
  const started = Date.now();

  await chineseKokoroRuntime.load();

  console.log('[runtime-v1] Chinese Kokoro initialized in', Date.now() - started, 'ms');
  console.log('[runtime-v1] voices ready:', chineseKokoroRuntime.getVoices().length);

  const results = [];
  let peakRss = process.memoryUsage().rss;

  for (let i = 0; i < count; i += 1) {
    const t0 = Date.now();
    const wav = await chineseKokoroRuntime.synthesizeWav(text, voice);
    const validation = validateWav(wav);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    results.push({
      index: i + 1,
      ms: Date.now() - t0,
      bytes: validation.bytes,
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });

    console.log(
      '[runtime-v1] synthesis',
      i + 1,
      '/',
      count,
      JSON.stringify(results[results.length - 1])
    );
  }

  const output = process.env.KOKORO_V1_TEST_OUTPUT;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    const wav = await chineseKokoroRuntime.synthesizeWav(text, voice);
    fs.writeFileSync(output, wav);
    console.log('[runtime-v1] wrote WAV:', path.resolve(output));
  }

  console.log(
    JSON.stringify(
      {
        pass: true,
        count,
        voice,
        beforeRssMB: Math.round(before / 1024 / 1024),
        peakRssMB: Math.round(peakRss / 1024 / 1024),
        deltaRssMB: Math.round((peakRss - before) / 1024 / 1024),
        results,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        host: os.hostname(),
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error('[runtime-v1] FAIL:', error.stack || error);
  process.exitCode = 1;
});
