require('dotenv').config();
const { readEventsDb, writeEventsDb, readSettings, writeSettings, updateEvent } = require('../lib/store');

async function testToggleAllEvents() {
  console.log("=== Testing Toggle 'Show Photos in Public Gallery' for All Photos / All Events ===");
  
  // 1. Fetch current status
  let events = await readEventsDb();
  let allEvt = events.find(e => e.id === 'all');
  console.log("Initial allEvt showInPublicGallery:", allEvt ? allEvt.showInPublicGallery : undefined);

  // 2. Set showInPublicGallery to false
  await updateEvent('all', { showInPublicGallery: false });
  events = await readEventsDb();
  allEvt = events.find(e => e.id === 'all');
  console.log("After setting false -> allEvt showInPublicGallery:", allEvt ? allEvt.showInPublicGallery : undefined);

  // 3. Set showInPublicGallery to true
  await updateEvent('all', { showInPublicGallery: true });
  events = await readEventsDb();
  allEvt = events.find(e => e.id === 'all');
  console.log("After setting true -> allEvt showInPublicGallery:", allEvt ? allEvt.showInPublicGallery : undefined);

  console.log("=== Test Completed Successfully ===");
}

testToggleAllEvents().then(() => process.exit(0)).catch(err => {
  console.error("Test Error:", err);
  process.exit(1);
});
