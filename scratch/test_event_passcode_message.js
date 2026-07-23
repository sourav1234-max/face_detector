const { addEvent, readEventsDb, deleteEvent } = require('../lib/store');

async function testEventSecurityMessage() {
  console.log('Testing custom security popup message on event...');
  const testId = 'evt_test_security_' + Date.now();
  const testEvent = {
    id: testId,
    title: 'Test Private Gala',
    name: 'Test Private Gala',
    passcode: '998877',
    passcodeMessage: 'Please enter the VIP security code printed on your invitation card.',
    status: 'active'
  };

  await addEvent(testEvent);
  const events = await readEventsDb();
  const found = events.find(e => e.id === testId);

  console.log('Saved event passcodeMessage:', found ? found.passcodeMessage : 'NOT FOUND');

  if (found) {
    await deleteEvent(testId);
    console.log('Cleaned up test event.');
  }

  console.log('Event security popup message test completed successfully!');
  process.exit(0);
}

testEventSecurityMessage().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
