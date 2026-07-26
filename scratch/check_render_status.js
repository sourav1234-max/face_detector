const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('--- Checking Render Backend Health ---');
  try {
    const health = await fetchJson('https://face-detector-wksm.onrender.com/api/health');
    console.log('Health Response:', JSON.stringify(health, null, 2));
  } catch (err) {
    console.error('Health Fetch Failed:', err.message);
  }

  console.log('\n--- Checking Render Cache Progress ---');
  try {
    const progress = await fetchJson('https://face-detector-wksm.onrender.com/api/cache/progress');
    console.log('Cache Progress Response:', JSON.stringify(progress, null, 2));
  } catch (err) {
    console.error('Cache Progress Fetch Failed:', err.message);
  }

  console.log('\n--- Checking Render System Status ---');
  try {
    const status = await fetchJson('https://face-detector-wksm.onrender.com/api/system/status');
    console.log('System Status Response:', JSON.stringify(status, null, 2));
  } catch (err) {
    console.error('System Status Fetch Failed:', err.message);
  }
}

run();
