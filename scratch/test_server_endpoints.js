const http = require('http');

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:3009${path}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  const app = require('../server.js');
  const server = app.listen(3009, '127.0.0.1');

  await new Promise(r => setTimeout(r, 2000));

  console.log('\n--- Testing GET /api/health ---');
  const health = await fetchJson('/api/health');
  console.log('Health:', JSON.stringify(health, null, 2));

  console.log('\n--- Testing GET /api/cache/status ---');
  const cacheStatus = await fetchJson('/api/cache/status');
  console.log('Cache Status:', JSON.stringify(cacheStatus, null, 2));

  console.log('\n--- Testing GET /api/system/status ---');
  const sysStatus = await fetchJson('/api/system/status');
  console.log('System Status:', JSON.stringify(sysStatus, null, 2));

  server.close(() => {
    console.log('\nServer closed cleanly.');
    process.exit(0);
  });
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
