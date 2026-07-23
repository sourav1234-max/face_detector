require('dotenv').config();
const { readSettings, readEventsDb, updateEvent, writeSettings } = require('../lib/store');

async function main() {
  try {
    const settings = await readSettings();
    console.log("Current settings galleryMessage:", settings.galleryMessage);

    const events = await readEventsDb();
    const allEvt = events.find(e => e.id === 'all');
    console.log("Current event 'all' announcementMessage:", allEvt ? allEvt.announcementMessage : "N/A");

    // Clear stale 'sourav' announcementMessage on event 'all' or sync with settings.galleryMessage
    const correctMessage = settings.galleryMessage || '';
    if (allEvt) {
      allEvt.announcementMessage = correctMessage;
      await updateEvent('all', { announcementMessage: correctMessage });
      console.log("Successfully updated event 'all' announcementMessage to:", correctMessage);
    }
  } catch (err) {
    console.error("Error fixing announcement:", err);
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 1000);
});
