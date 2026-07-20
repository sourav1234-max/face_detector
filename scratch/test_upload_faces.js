const fs = require('fs');
const http = require('http');

const sampleImagePath = `C:\\Users\\SOURAV SENAPATI\\.gemini\\antigravity-ide\\brain\\7a468043-701e-4065-91e2-7a7fd9d061a3\\sample_face_1784463384416.png`;
if (!fs.existsSync(sampleImagePath)) {
  console.error('Sample face image not found:', sampleImagePath);
  process.exit(1);
}

const fileBuffer = fs.readFileSync(sampleImagePath);
const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

const postData = [];
postData.push(Buffer.from(`--${boundary}\r\n`));
postData.push(Buffer.from(`Content-Disposition: form-data; name="photo"; filename="portrait_test.png"\r\n`));
postData.push(Buffer.from(`Content-Type: image/png\r\n\r\n`));
postData.push(fileBuffer);
postData.push(Buffer.from(`\r\n--${boundary}--\r\n`));

const payload = Buffer.concat(postData);

console.log('Sending upload request for portrait_test.png...');
const req = http.request({
  host: 'localhost',
  port: 3000,
  path: '/api/upload',
  method: 'POST',
  headers: {
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': payload.length
  }
}, res => {
  console.log('STATUS:', res.statusCode);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('RESPONSE:', data);
  });
});

req.on('error', err => {
  console.error('REQUEST ERROR:', err);
});

req.write(payload);
req.end();
