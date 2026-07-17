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

async function testUpload() {
  try {
    console.log('Starting Google Drive upload test...');
    console.log('Client ID:', settings.googleClientId);
    console.log('Refresh Token:', settings.googleRefreshToken ? 'Present' : 'Missing');

    if (!settings.googleRefreshToken) {
      throw new Error('Google Drive is not connected (no refresh token).');
    }

    const oauth2Client = getGoogleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: settings.googleRefreshToken });
    
    console.log('Refreshing access token...');
    const { credentials } = await oauth2Client.refreshAccessToken();
    console.log('Access token refreshed successfully.');

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Try listing files
    console.log('Testing drive files list...');
    const listRes = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and name='FaceMatch_Photos' and trashed=false",
      fields: 'files(id)',
      spaces: 'drive'
    });
    console.log('Drive list files response:', JSON.stringify(listRes.data));

    let folderId = '';
    if (listRes.data.files.length > 0) {
      folderId = listRes.data.files[0].id;
      console.log('Found existing folder ID:', folderId);
    } else {
      console.log('Folder not found. Creating folder "FaceMatch_Photos"...');
      const folderMetadata = {
        name: 'FaceMatch_Photos',
        mimeType: 'application/vnd.google-apps.folder'
      };
      const createFolder = await drive.files.create({
        resource: folderMetadata,
        fields: 'id'
      });
      folderId = createFolder.data.id;
      console.log('Created folder ID:', folderId);
    }

    // Try uploading a small file
    const fileBuffer = Buffer.from('Hello world from FaceMatch test upload');
    const stream = require('stream');
    const bufferStream = new stream.PassThrough();
    bufferStream.end(fileBuffer);

    const fileMetadata = {
      name: 'test_upload.txt',
      parents: folderId ? [folderId] : []
    };
    const media = {
      mimeType: 'text/plain',
      body: bufferStream
    };

    console.log('Uploading test file to folder...');
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id'
    });
    console.log('Upload success! File ID:', response.data.id);
  } catch (error) {
    console.error('Test upload failed with error:', error);
  }
}

testUpload();
