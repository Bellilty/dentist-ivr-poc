// calendar-test.js
const fs = require('fs');
const { google } = require('googleapis');
require('dotenv').config();

// Charger les credentials et le token
const credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_CREDENTIALS_PATH));
const token = JSON.parse(fs.readFileSync(process.env.GOOGLE_TOKEN_PATH));

const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(token);

// Initialiser le service Calendar
const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

(async () => {
  try {
    // ✅ 1) Lister les calendriers disponibles
    console.log("📅 Listing available calendars...");
    const res = await calendar.calendarList.list();
    res.data.items.forEach((cal, i) => {
      console.log(`(${i + 1}) ${cal.summary} — ID: ${cal.id}`);
    });

    // ✅ 2) Créer un événement test demain à midi (durée 1h)
    const now = new Date();
    now.setDate(now.getDate() + 1);
    now.setHours(12, 0, 0, 0);
    const start = now.toISOString();
    const end = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // +1h

    const event = {
      summary: "🧪 Test Dentist POC",
      description: "Événement de test créé automatiquement",
      start: { dateTime: start, timeZone: process.env.CLINIC_TIMEZONE },
      end: { dateTime: end, timeZone: process.env.CLINIC_TIMEZONE },
    };

    const inserted = await calendar.events.insert({
      calendarId: process.env.DEFAULT_CALENDAR_ID,
      requestBody: event,
    });

    console.log("\n✅ Événement créé avec succès !");
    console.log("📅 Titre :", inserted.data.summary);
    console.log("🕐 Début :", inserted.data.start.dateTime);
    console.log("📍 Lien :", inserted.data.htmlLink);

  } catch (err) {
    console.error("❌ Erreur :", err.message);
  }
})();
