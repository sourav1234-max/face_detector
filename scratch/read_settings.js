require('dotenv').config();
const { readSettings } = require('../lib/store');

async function main() {
  try {
    console.log("Reading settings from store...");
    const settings = await readSettings();
    console.log("Settings:");
    console.log(JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("Error reading settings:", err);
  }
  process.exit(0);
}

main();
