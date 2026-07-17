const mysql = require('mysql2/promise');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Helper to make API requests
function makeRequest(url, method, headers = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: JSON.parse(data || '{}')
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== STARTING MYSQL TRANSITION VERIFICATION ===');
  
  // 1. Check local MySQL connection
  console.log('Test 1: Testing direct MySQL connection using .env variables...');
  const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    port: 3306
  };

  // Read .env if exists to override
  const envPath = path.join(__dirname, '..', '..', '..', '..', '..', 'photo', '.env');
  if (fs.existsSync(envPath)) {
    const data = fs.readFileSync(envPath, 'utf8');
    data.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length === 2) {
        const key = parts[0].trim();
        const val = parts[1].trim();
        if (key === 'DB_HOST') dbConfig.host = val;
        if (key === 'DB_USER') dbConfig.user = val;
        if (key === 'DB_PASSWORD') dbConfig.password = val;
        if (key === 'DB_PORT') dbConfig.port = parseInt(val, 10);
      }
    });
  }

  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('Success: Connected to MySQL host successfully!\n');
    await connection.end();
  } catch (err) {
    console.error(`Error: Could not connect to MySQL server. Please make sure MySQL is running on ${dbConfig.host}:${dbConfig.port} and username/password are correct.`);
    console.error(`Details: ${err.message}\n`);
    console.log('Cancelling API tests as MySQL is unreachable.');
    return;
  }

  // 2. Test API routes
  try {
    console.log('Test 2: Fetching public gallery API...');
    const galleryRes = await makeRequest('http://localhost:3000/api/gallery', 'GET');
    console.log(`Status: ${galleryRes.statusCode}, Success: ${galleryRes.body.success}`);
    console.log(`Photos count: ${galleryRes.body.photos ? galleryRes.body.photos.length : 0}`);
    console.log(`Dynamic Logo Width: ${galleryRes.body.logoWidth}px\n`);

    console.log('Test 3: Admin login with correct password...');
    const loginRes = await makeRequest('http://localhost:3000/api/admin/login', 'POST', {}, { password: 'admin123' });
    console.log(`Status: ${loginRes.statusCode}, Success: ${loginRes.body.success}\n`);

    console.log('Test 4: Fetching admin dashboard settings...');
    const settingsRes = await makeRequest('http://localhost:3000/api/admin/settings', 'GET', { 'x-admin-password': 'admin123' });
    console.log(`Status: ${settingsRes.statusCode}, Success: ${settingsRes.body.success}`);
    console.log(`Settings: ${JSON.stringify(settingsRes.body.settings)}\n`);

    console.log('=== MYSQL TRANSITION VERIFICATION COMPLETED ===');
  } catch (err) {
    console.error('API request failed. Make sure the Node server is running on port 3000.');
    console.error(`Error details: ${err.message}\n`);
  }
}

runTests();
