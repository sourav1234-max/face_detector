const http = require('http');

function testAdminLogin(password) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ password });
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/admin/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, json, cookies: res.headers['set-cookie'] });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('Testing Admin Login API...');
  const res1 = await testAdminLogin('wrongpassword');
  console.log('Wrong Password Test:', res1);

  const res2 = await testAdminLogin('admin123');
  console.log('Correct Password Test:', res2);

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
