const http = require('http');

function makeRequest(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : '';
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': 'admin123',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, json });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('Testing full admin API endpoints...');
  const settings = await makeRequest('/api/admin/settings');
  console.log('Settings status:', settings.status, 'success:', settings.json ? settings.json.success : false);

  const gallery = await makeRequest('/api/admin/gallery');
  console.log('Gallery status:', gallery.status, 'success:', gallery.json ? gallery.json.success : false);

  const events = await makeRequest('/api/events');
  console.log('Events status:', events.status, 'count:', events.json ? (events.json.events ? events.json.events.length : 0) : 0);

  console.log('All admin endpoints responded successfully!');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
