require('dotenv').config();
const { updateEvent, readEventsDb, readSettings, writeSettings } = require('../lib/store');

async function testPasscodeAll() {
  console.log("=== Testing Passcode Enforcement on All Photos / All Events ===");
  
  // Set passcode on all event
  await updateEvent('all', { passcode: '722150' });
  const events = await readEventsDb();
  const allEvt = events.find(e => e.id === 'all');
  console.log("allEvt passcode:", allEvt ? allEvt.passcode : 'none');

  console.log("=== Test Complete ===");
}

testPasscodeAll().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
