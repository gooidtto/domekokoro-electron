const { health } = require('./kokoro-api-client');

async function waitForHealthy(options = {}, timeoutMs = 60000) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const result = await health(options);
      if (result.ready) return result;
      lastError = new Error(result.error || 'Kokoro sidecar is not ready');
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for Kokoro sidecar: ' + (lastError?.message || 'unknown error'));
}

module.exports = { waitForHealthy };
