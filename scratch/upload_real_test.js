const fs = require('fs');
const http = require('http');
const path = require('path');

const imgPath = path.join(__dirname, 'upload_1784475000887_02ijll0cx.jpg');
if (!fs.existsSync(imgPath)) {
  console.error("Test image not found at:", imgPath);
  process.exit(1);
}

const fileBuffer = fs.readFileSync(imgPath);
const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
const parts = [];
parts.push(Buffer.from(`--${boundary}\r\n`));
parts.push(Buffer.from('Content-Disposition: form-data; name="photo"; filename="test-upload.jpg"\r\n'));
parts.push(Buffer.from('Content-Type: image/jpeg\r\n\r\n'));
parts.push(fileBuffer);
parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
const payload = Buffer.concat(parts);

console.log("Sending upload request to http://localhost:3000/api/upload ...");

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
  console.log('HEADERS:', JSON.stringify(res.headers));
  let data = '';
  res.on('data', chunk => data += chunk.toString('utf8'));
  res.on('end', () => {
    console.log('BODY:', data);
  });
});

req.on('error', err => {
  console.error('REQ ERROR:', err);
});

req.write(payload);
req.end();
