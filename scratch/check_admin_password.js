const { readSettings } = require('../lib/store');

async function checkPass() {
  const s = await readSettings();
  console.log('Stored adminPassword:', JSON.stringify(s.adminPassword));
  process.exit(0);
}

checkPass().catch(err => {
  console.error(err);
  process.exit(1);
});
