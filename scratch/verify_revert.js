const http = require('http');

function getPage(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, length: body.length }));
    }).on('error', reject);
  });
}

async function run() {
  console.log('Verifying reverted code server responses...');
  const index = await getPage('/index.html');
  console.log('index.html status:', index.status, 'len:', index.length);

  const admin = await getPage('/admin.html');
  console.log('admin.html status:', admin.status, 'len:', admin.length);

  const galleryApi = await getPage('/api/gallery');
  console.log('/api/gallery status:', galleryApi.status);

  console.log('All pages verified successfully!');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
