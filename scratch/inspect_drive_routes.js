const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lines = content.split('\n');

console.log('=== SEARCHING FOR DRIVE / PHOTO ROUTES IN SERVER.JS ===');
lines.forEach((line, idx) => {
  if (line.includes('app.get') || line.includes('drive') || line.includes('/api/')) {
    if (line.includes('drive') || line.includes('photo') || line.includes('file')) {
      console.log(`L${idx + 1}: ${line.trim()}`);
    }
  }
});
