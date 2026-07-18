const fs = require('fs');
const http = require('http');
const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/B8AAn8B9a0J8oMAAAAASUVORK5CYII=', 'base64');
const parts = [];
parts.push(Buffer.from(`--${boundary}\r\n`));
parts.push(Buffer.from('Content-Disposition: form-data; name="photo"; filename="test-upload.png"\r\n'));
parts.push(Buffer.from('Content-Type: image/png\r\n\r\n'));
parts.push(png);
parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
const payload = Buffer.concat(parts);
const req = http.request({ host: 'localhost', port: 3000, path: '/api/upload', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length } }, res => {
  console.log('STATUS', res.statusCode);
  console.log('HEADERS', JSON.stringify(res.headers));
  let data = '';
  res.on('data', chunk => data += chunk.toString('utf8'));
  res.on('end', () => {
    console.log('BODY', data);
  });
});
req.on('error', err => {
  console.error('REQ ERROR', err);
});
req.write(payload);
req.end();