require('dotenv').config();
const { readSettings, readEventsDb } = require('../lib/store');

async function main() {
  try {
    const settings = await readSettings();
    console.log("=== SETTINGS ===");
    console.log(JSON.stringify(settings, null, 2));

    const events = await readEventsDb();
    console.log("\n=== EVENTS ===");
    console.log(JSON.stringify(events, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 1000);
});
