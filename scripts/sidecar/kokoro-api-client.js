const http = require('http');

function request({ host = '127.0.0.1', port = 17861, path, method = 'GET', body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path,
      method,
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      } : undefined,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(60000, () => req.destroy(new Error('Kokoro sidecar request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function health(options = {}) {
  const response = await request({ ...options, path: '/health' });
  return JSON.parse(response.body.toString('utf8'));
}

async function listVoices(options = {}) {
  const response = await request({ ...options, path: '/v1/voices' });
  if (response.status !== 200) throw new Error(response.body.toString('utf8'));
  return JSON.parse(response.body.toString('utf8')).voices;
}

async function synthesize({ text, voice = 'zf_001', speed = 1.0, ...options }) {
  const body = JSON.stringify({
    model: 'kokoro-v1.1-zh',
    input: text,
    voice,
    speed,
    response_format: 'wav',
  });
  const response = await request({
    ...options,
    path: '/v1/audio/speech',
    method: 'POST',
    body,
  });
  if (response.status !== 200) throw new Error(response.body.toString('utf8'));
  return response.body;
}

module.exports = { health, listVoices, synthesize };
