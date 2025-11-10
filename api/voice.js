import { google } from "googleapis";
import twilio from "twilio";
import * as chrono from "chrono-node";
import OpenAI from "openai";

const VoiceResponse = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- GOOGLE CALENDAR AUTH --- //
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

// --- Whisper STT (pour Hébreu) --- //
async function transcribeAudio(fileUrl) {
  const response = await openai.audio.transcriptions.create({
    file: fileUrl,
    model: "whisper-1",
    language: "he",
  });
  return response.text;
}

// --- MAIN HANDLER --- //
export default async function handler(req, res) {
  console.log("🟢 STEP:", req.query.step || "start");
  console.log("🟡 BODY:", req.body);

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const vr = new VoiceResponse();
  const step = req.query.step || "start";

  try {
    // --- STEP 1: Language selection ---
    if (step === "start") {
      const gather = vr.gather({
        input: "speech dtmf",
        numDigits: 1,
        action: "https://dentist-ivr-poc.vercel.app/api/voice?step=lang",
        method: "POST",
        speechTimeout: "auto",
        timeout: 10,
        bargeIn: true, // permet d'interrompre la lecture
      });

      gather.say({ language: "en-US" }, "For service in English, press 1.");
      gather.say({ language: "fr-FR" }, "Pour le service en français, appuyez sur 2.");
      gather.play("https://dentist-ivr-poc.vercel.app/audio/press-3-he.mp3");

      res.setHeader("Content-Type", "text/xml");
      res.send(vr.toString());
      return;
    }

    // --- STEP 2: Ask for name + date ---
    if (step === "lang") {
      const digits = req.body.Digits;
      const speech = (req.body.SpeechResult || "").toLowerCase();

      let key = "1"; // default English
      if (digits === "2" || speech.includes("fran")) key = "2";
      else if (digits === "3" || speech.includes("ivrit") || speech.includes("עברית")) key = "3";

      const langs = { "1": "en-US", "2": "fr-FR", "3": "he-IL" };
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

      if (key === "3")
        gather.play("https://dentist-ivr-poc.vercel.app/audio/welcome-he.mp3");
      else gather.say({ language: langs[key] }, prompts[key]);

      res.setHeader("Content-Type", "text/xml");
      res.send(vr.toString());
      return;
    }

    // --- STEP 3: Parse and schedule ---
    if (step === "collect") {
      const lang = req.query.lang || "1";
      let utterance = req.body.SpeechResult || "";
      const from = req.body.From || "";
      const recordingUrl = req.body.RecordingUrl;

      if (lang === "3" && recordingUrl) {
        console.log("🎧 Transcribing Hebrew with Whisper...");
        utterance = await transcribeAudio(recordingUrl);
        console.log("🗣️ Whisper transcription:", utterance);
      }

      console.log("🧠 Speech input:", utterance);

      let whenISO, name;
      const currentYear = new Date().getFullYear();

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Tu es un assistant de prise de rendez-vous médical.
              Extrais le *nom complet* et la *date exacte* de la phrase donnée.
              Si aucune année n’est précisée, considère que nous sommes en ${currentYear}.
              Retourne un JSON strict du format :
              {"date_iso": "YYYY-MM-DDTHH:mm:ssZ", "name": "Nom du patient"}.
              Ne mets rien d'autre que ce JSON.`,
            },
            { role: "user", content: utterance },
          ],
          temperature: 0.1,
        });

        const data = JSON.parse(completion.choices[0].message.content.trim());
        whenISO = data.date_iso;
        name = data.name || "Patient";

        const parsedDate = new Date(whenISO);
        if (parsedDate.getFullYear() < currentYear) {
          parsedDate.setFullYear(currentYear);
          whenISO = parsedDate.toISOString();
        }
      } catch (e) {
        console.error("⚠️ OpenAI error:", e.message);
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

        const msgs = {
          "1": `Thank you ${name}. Your appointment has been scheduled for ${new Date(
            whenISO
          ).toLocaleString("en-US", { timeZone: process.env.CLINIC_TIMEZONE })}. Goodbye!`,
          "2": `Merci ${name}. Votre rendez-vous a bien été enregistré pour le ${new Date(
            whenISO
          ).toLocaleString("fr-FR", { timeZone: process.env.CLINIC_TIMEZONE })}. À bientôt !`,
        };

        if (lang === "3")
          vr.play("https://dentist-ivr-poc.vercel.app/audio/confirm-he.mp3");
        else vr.say({ language: { "1": "en-US", "2": "fr-FR" }[lang] }, msgs[lang]);
      } catch (err) {
        console.error("❌ Calendar error:", err.message);
        vr.say({ language: "en-US" }, "Sorry, there was an issue scheduling your appointment.");
      }

      res.setHeader("Content-Type", "text/xml");
      res.send(vr.toString());
    }
  } catch (err) {
    console.error("🔥 FATAL ERROR:", err.message);
    vr.say({ language: "en-US" }, "Sorry, something went wrong on our end.");
    res.setHeader("Content-Type", "text/xml");
    res.send(vr.toString());
  }
}
