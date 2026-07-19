const fs = require('fs');
const path = require('path');

const fileId = '1hMOCMYKJKvpaJrxzmJUl3WPIjgdtPz9H';
const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
const destPath = path.join(__dirname, 'user_test.jpg');

console.log(`Downloading file from ${url}...`);

async function main() {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download: ${res.status} ${res.statusText}`);
    }
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buffer));
    console.log("Download complete!");
    process.exit(0);
  } catch (err) {
    console.error("Download error:", err);
    process.exit(1);
  }
}

main();

