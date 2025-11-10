/**
 * POC - Assistant vocal dentiste (Twilio + Google Calendar)
 * ---------------------------------------------------------
 * ✅ Répond aux appels entrants
 * ✅ Choix de langue (oral ou DTMF)
 * ✅ Comprend la date/heure/nom du patient
 * ✅ Crée le rendez-vous dans Google Calendar
 * ✅ Confirme vocalement (pas de SMS)
 */

const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const twilio = require("twilio");
const { google } = require("googleapis");
const fs = require("fs");
const chrono = require("chrono-node");
const OpenAI = require("openai");

dotenv.config();
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- INITIALISATIONS ---
const VoiceResponse = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------- GOOGLE CALENDAR ---------------- //
function getOAuthClient() {
  const credentials = JSON.parse(
    fs.readFileSync(process.env.GOOGLE_CREDENTIALS_PATH)
  );
  const token = JSON.parse(fs.readFileSync(process.env.GOOGLE_TOKEN_PATH));
  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function createCalendarEvent({ summary, startISO, minutes, phone }) {
  const auth = getOAuthClient();
  const calendar = google.calendar({ version: "v3", auth });
  const start = new Date(startISO);
  const end = new Date(start.getTime() + minutes * 60000);

  const event = {
    summary,
    description: `RDV automatique – patient : ${phone}`,
    start: { dateTime: start.toISOString(), timeZone: process.env.CLINIC_TIMEZONE },
    end: { dateTime: end.toISOString(), timeZone: process.env.CLINIC_TIMEZONE },
  };

  await calendar.events.insert({
    calendarId: process.env.DEFAULT_CALENDAR_ID,
    requestBody: event,
  });

  return event;
}

// ---------------- LANGUES ---------------- //
const LANGS = {
  "1": { code: "he-IL", label: "עברית" },
  "2": { code: "en-US", label: "English" },
  "3": { code: "fr-FR", label: "Français" },
};

// ---------------- ROUTES TWILIO ---------------- //

app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();
  const gather = vr.gather({
    input: "speech dtmf",
    numDigits: 1,
    action: "/lang",
    method: "POST",
    speechTimeout: "auto",
  });

  gather.say(
    "For Hebrew say Ivrit or press 1. For English press 2. Pour le français appuyez sur 3."
  );
  res.type("text/xml");
  res.send(vr.toString());
});

app.post("/lang", (req, res) => {
  const digits = req.body.Digits;
  const speech = (req.body.SpeechResult || "").toLowerCase();

  let key = "2"; // default English
  if (LANGS[digits]) key = digits;
  else if (speech.includes("ivrit") || speech.includes("hebrew")) key = "1";
  else if (speech.includes("fran") || speech.includes("français")) key = "3";

  const lang = LANGS[key];
  const vr = new VoiceResponse();
  const gather = vr.gather({
    input: "speech",
    action: `/collect?lang=${key}`,
    method: "POST",
    language: lang.code,
    speechTimeout: "auto",
  });

  const prompts = {
    "1": "שלום! באיזה תאריך ושעה נוח לך להגיע, ומה השם שלך?",
    "2": "Great! What date and time suit you, and what is your name?",
    "3": "Très bien. Quelle date et quelle heure vous conviennent, et quel est votre nom ?",
  };

  gather.say({ language: lang.code }, prompts[key]);
  res.type("text/xml");
  res.send(vr.toString());
});

app.post("/collect", async (req, res) => {
  const lang = req.query.lang || "2";
  const utterance = req.body.SpeechResult || "";
  const from = req.body.From || "";
  const vr = new VoiceResponse();

  // --- Analyse de la phrase (OpenAI ou fallback chrono) ---
  let whenISO, name;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Tu es un assistant qui extrait les informations d'un rendez-vous : date, heure et nom du patient. Réponds en JSON {date_iso, name}.",
        },
        { role: "user", content: utterance },
      ],
      temperature: 0.2,
    });

    const data = JSON.parse(completion.choices[0].message.content);
    whenISO = data.date_iso;
    name = data.name || "Patient";
  } catch {
    // Fallback sans OpenAI
    const parsed = chrono.parseDate(utterance);
    whenISO = parsed
      ? parsed.toISOString()
      : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const match = utterance.match(/je (suis|m'appelle)\s+([A-Za-zÀ-ÖØ-öø-ÿ'-]+)/i);
    name = match && match[2] ? match[2] : "Patient";
  }

  // --- Création de l'événement ---
  const minutes = parseInt(process.env.DEFAULT_APPT_MINUTES || "30", 10);
  await createCalendarEvent({
    summary: `${process.env.CLINIC_NAME} – RDV ${name}`,
    startISO: whenISO,
    minutes,
    phone: from,
  });

  // --- Confirmation vocale ---
  const msg = {
    "1": `הפגישה נקבעה בהצלחה. נתראה בקרוב!`,
    "2": `Your appointment has been booked successfully. Goodbye!`,
    "3": `Votre rendez-vous a bien été enregistré. À bientôt !`,
  }[lang];
  vr.say({ language: LANGS[lang].code }, msg);

  console.log(`✅ RDV confirmé pour ${from} à ${whenISO}`);

  res.type("text/xml");
  res.send(vr.toString());
});

app.get("/", (req, res) => res.send("✅ Voice assistant POC sans SMS, 3 langues (he/en/fr)"));

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 IVR POC running on port", process.env.PORT || 3000);
});
