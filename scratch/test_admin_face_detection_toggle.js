const { readSettings, sanitizeSettingsForClient } = require('../lib/store');

async function testToggle() {
  console.log('Testing faceDetectionEnabled setting...');
  const s = await readSettings();
  console.log('Current faceDetectionEnabled:', s.faceDetectionEnabled);
  const clientSettings = sanitizeSettingsForClient(s);
  console.log('Sanitized client settings faceDetectionEnabled:', clientSettings.faceDetectionEnabled);
  console.log('Test completed successfully.');
  process.exit(0);
}

testToggle().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
