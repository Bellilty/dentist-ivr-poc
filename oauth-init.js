// oauth-init.js
const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');
require('dotenv').config();

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const CRED_PATH = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || './token.json';

function authorize() {
  if (!fs.existsSync(CRED_PATH)) {
    console.error('❌ credentials.json not found at:', CRED_PATH);
    process.exit(1);
  }

  const content = fs.readFileSync(CRED_PATH, 'utf8');
  const credentials = JSON.parse(content).installed || JSON.parse(content).web;
  const { client_secret, client_id, redirect_uris } = credentials;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('\n🌐 Open this URL in your browser:\n\n', authUrl, '\n');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('👉 Paste the code here: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log('✅ Token stored to', TOKEN_PATH);
    } catch (err) {
      console.error('❌ Error retrieving token:', err.message);
    }
  });
}

authorize();
