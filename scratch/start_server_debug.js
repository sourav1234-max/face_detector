const app = require('../server.js');

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Test Express Server is running on port ${PORT}`);
  console.log(`==================================================`);
});

server.on('error', (err) => {
  console.error('[Server Error]:', err);
});
