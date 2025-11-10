// api/voice.js
import { google } from "googleapis";
import twilio from "twilio";
import * as chrono from "chrono-node";
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const VoiceResponse = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------------------------------------------------------
   GOOGLE CALENDAR AUTH
--------------------------------------------------------- */
function getOAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const token = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || "https://developers.google.com/oauthplayground"
  );
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function createCalendarEvent({ summary, startISO, minutes, phone }) {
  console.log("📅 Creating event:", summary, startISO);
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

  console.log("✅ Event created successfully");
  return event;
}

/* ---------------------------------------------------------
   TWILIO AUDIO → DOWNLOAD → WHISPER TRANSCRIPTION
--------------------------------------------------------- */
async function transcribeAudioFromTwilio(recordingUrl) {
  try {
    console.log("🎧 Downloading Twilio recording:", recordingUrl);

    const auth = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const response = await fetch(`${recordingUrl}.mp3`, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!response.ok) throw new Error(`❌ Failed to download: ${response.status}`);

    const tempFile = path.join("/tmp", `recording-${Date.now()}.mp3`);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(tempFile, Buffer.from(buffer));

    console.log("📤 Sending audio to OpenAI (gpt-4o-mini-transcribe)...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: "gpt-4o-mini-transcribe",
      response_format: "json",
      language: "he", // hébreu explicite
      prompt: "שיחה לקביעת תור לרופא שיניים. השתמש במילים רפואיות מדויקות והקפד על דיוק בזמנים.",
    });

    fs.unlinkSync(tempFile);
    console.log("✅ Whisper result:", transcription.text);
    return transcription.text || "";
  } catch (err) {
    console.error("🚨 Whisper or download error:", err.message);
    return "";
  }
}

/* ---------------------------------------------------------
   MAIN HANDLER (Twilio Webhook)
--------------------------------------------------------- */
export default async function handler(req, res) {
  console.log("🟢 STEP:", req.query.step || "start");
  console.log("🟡 BODY:", req.body);

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const vr = new VoiceResponse();
  const step = req.query.step || "start";

  try {
    /* -----------------------------------------------------
       STEP 1 — LANGUAGE SELECTION
    ----------------------------------------------------- */
    if (step === "start") {
      const gather = vr.gather({
        input: "speech dtmf",
        numDigits: 1,
        action: "https://dentist-ivr-poc.vercel.app/api/voice?step=lang",
        method: "POST",
        speechTimeout: "auto",
        timeout: 10,
        bargeIn: true,
      });

      gather.say({ language: "en-US" }, "For service in English, press 1.");
      gather.say({ language: "fr-FR" }, "Pour le service en français, appuyez sur 2.");
      gather.play("https://dentist-ivr-poc.vercel.app/audio/press-3-he.mp3");

      res.setHeader("Content-Type", "text/xml");
      res.send(vr.toString());
      return;
    }

    /* -----------------------------------------------------
       STEP 2 — ASK NAME + DATE
    ----------------------------------------------------- */
    if (step === "lang") {
      const digits = req.body.Digits;
      const speech = (req.body.SpeechResult || "").toLowerCase();

      let key = "1"; // default English
      if (digits === "2" || speech.includes("fran")) key = "2";
      else if (digits === "3" || speech.includes("ivrit") || speech.includes("עברית")) key = "3";

      const langs = { "1": "en-US", "2": "fr-FR", "3": "he-IL" };

      if (key === "3") {
        vr.play("https://dentist-ivr-poc.vercel.app/audio/welcome-he.mp3");
        vr.record({
          action: `https://dentist-ivr-poc.vercel.app/api/voice?step=collect&lang=3`,
          method: "POST",
          maxLength: "60",
          timeout: "10",
          playBeep: false,
        });
      } else {
        const prompts = {
          "1": "Welcome to Doctor B's clinic. Please say your name and the date and time you'd like for your appointment.",
          "2": "Bienvenue au cabinet du docteur B. Veuillez indiquer votre nom ainsi que la date et l’heure souhaitées pour votre rendez-vous.",
        };

        const gather = vr.gather({
          input: "speech",
          action: `https://dentist-ivr-poc.vercel.app/api/voice?step=collect&lang=${key}`,
          method: "POST",
          language: langs[key],
          speechTimeout: "auto",
          timeout: 20,
          bargeIn: true,
        });

        gather.say({ language: langs[key] }, prompts[key]);
      }

      res.setHeader("Content-Type", "text/xml");
      res.send(vr.toString());
      return;
    }

    /* -----------------------------------------------------
       STEP 3 — PARSE & CREATE CALENDAR EVENT
    ----------------------------------------------------- */
    if (step === "collect") {
      const lang = req.query.lang || "1";
      let utterance = req.body.SpeechResult || "";
      const from = req.body.From || "";
      const recordingUrl = req.body.RecordingUrl;

      if (lang === "3" && recordingUrl) {
        console.log("🎙️ Hebrew mode active — fetching audio...");
        utterance = await transcribeAudioFromTwilio(recordingUrl);
      }

      if (!utterance) {
        console.warn("⚠️ No speech detected or Whisper failed");
        vr.say(
          { language: "en-US" },
          "Sorry, I could not understand your message. Please try again later."
        );
        res.setHeader("Content-Type", "text/xml");
        res.send(vr.toString());
        return;
      }

      console.log("🧠 Extracted speech:", utterance);
      let whenISO, name;
      const currentYear = new Date().getFullYear();

      try {
        const sysPrompt =
          lang === "3"
            ? `אתה עוזר קביעת תורים רפואיים. מהמשפט של המטופל, הפק את שם מלא ותאריך מדויק (כולל שעה אם יש). החזר JSON מדויק:
              {"date_iso": "YYYY-MM-DDTHH:mm:ssZ", "name": "שם המטופל"}.`
            : `You are a medical appointment assistant.
              Extract the patient's full name and exact appointment date/time.
              Return strict JSON only:
              {"date_iso": "YYYY-MM-DDTHH:mm:ssZ", "name": "Patient name"}.`;

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: utterance },
          ],
          temperature: 0.1,
        });

        const data = JSON.parse(completion.choices[0].message.content.trim());
        whenISO = data.date_iso;
        name = data.name || "Patient";
      } catch (e) {
        console.error("⚠️ OpenAI parsing error:", e.message);
        const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
        whenISO = parsed
          ? parsed.toISOString()
          : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        name = "Patient";
      }

      try {
        await createCalendarEvent({
          summary: `${process.env.CLINIC_NAME} – RDV ${name}`,
          startISO: whenISO,
          minutes: parseInt(process.env.DEFAULT_APPT_MINUTES || "30", 10),
          phone: from,
        });

        if (lang === "3") {
          vr.play("https://dentist-ivr-poc.vercel.app/audio/confirm-he.mp3");
        } else {
          const msgs = {
            "1": `Thank you ${name}. Your appointment has been scheduled for ${new Date(
              whenISO
            ).toLocaleString("en-US", { timeZone: process.env.CLINIC_TIMEZONE })}. Goodbye!`,
            "2": `Merci ${name}. Votre rendez-vous a bien été enregistré pour le ${new Date(
              whenISO
            ).toLocaleString("fr-FR", { timeZone: process.env.CLINIC_TIMEZONE })}. À bientôt !`,
          };
          vr.say({ language: { "1": "en-US", "2": "fr-FR" }[lang] }, msgs[lang]);
        }
      } catch (err) {
        console.error("❌ Calendar error:", err.message);
        vr.say(
          { language: "en-US" },
          "Sorry, there was an issue scheduling your appointment."
        );
      }

      res.setHeader("Content-Type", "text/xml");
      res.send(vr.toString());
      return;
    }
  } catch (err) {
    console.error("🔥 FATAL ERROR:", err.message, err.stack);
    vr.say({ language: "en-US" }, "Sorry, something went wrong on our end.");
    res.setHeader("Content-Type", "text/xml");
    res.send(vr.toString());
  }
}
