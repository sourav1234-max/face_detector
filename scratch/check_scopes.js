const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const settingsPath = path.join(__dirname, '..', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

function getGoogleOAuthClient() {
  if (!settings.googleClientId || !settings.googleClientSecret) {
    return null;
  }
  const redirectUri = 'http://localhost:3000/api/google/callback';
  return new google.auth.OAuth2(
    settings.googleClientId,
    settings.googleClientSecret,
    redirectUri
  );
}

async function checkScopes() {
  try {
    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    
    console.log('Refreshing token to get fresh access token...');
    const { credentials } = await oauth2Client.refreshAccessToken();
    const accessToken = credentials.access_token;
    
    console.log('Retrieving token info...');
    const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
    console.log('Token Info:', JSON.stringify(tokenInfo, null, 2));
  } catch (err) {
    console.error('Error checking scopes:', err);
  }
}

checkScopes();
