const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/admin/settings',
  method: 'GET',
  headers: {
    'x-admin-password': 'admin123'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('Response status:', res.statusCode);
    console.log('Response body:', JSON.stringify(JSON.parse(data), null, 2));
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.end();
