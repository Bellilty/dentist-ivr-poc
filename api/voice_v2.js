// api/voice_v2.js - Version avec Hugging Face Whisper pour l'hébreu + logs détaillés
import { google } from "googleapis";
import twilio from "twilio";
import * as chrono from "chrono-node";
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { transliterate as transliterateHebrew } from "hebrew-transliteration";

const VoiceResponse = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Utils + Logging ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helper pour logs avec timestamp
function logWithTime(message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
}

// Helper pour mesurer le temps d'exécution
function timeStart(label) {
    const start = Date.now();
    logWithTime(`⏱️ START: ${label}`);
    return function timeEnd() {
        const duration = Date.now() - start;
        logWithTime(`⏱️ END: ${label} (${duration}ms / ${(duration/1000).toFixed(2)}s)`);
        return duration;
    };
}

/* ---------- Google Calendar Auth ---------- */
function getOAuthClient() {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const token = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
    const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;

    const firstRedirectUri =
        Array.isArray(redirect_uris) && redirect_uris.length > 0 ?
        redirect_uris[0] :
        "https://developers.google.com/oauthplayground";

    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        firstRedirectUri
    );
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

async function createCalendarEvent({ summary, startISO, minutes, phone }) {
    const timer = timeStart("Calendar Event Creation");
    logWithTime("📅 Creating event:", summary, startISO);
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

    timer();
    logWithTime("✅ Event created successfully");
    return event;
}

/* ---------- Hugging Face Whisper (gratuit, open source) ---------- */
async function transcribeWithHuggingFace(audioFile, language = "he") {
    const timer = timeStart("Hugging Face Whisper Transcription");
    try {
        logWithTime("🤗 METHOD: Hugging Face Whisper (open source)");
        logWithTime(`📋 Language: ${language === "he" ? "Hebrew" : "English"}`);

        const hfToken = process.env.HUGGINGFACE_API_KEY || "";
        const hasToken = !!hfToken;
        logWithTime(`🔑 API Key: ${hasToken ? "✅ Present" : "⚠️ Not set (using free tier with rate limit)"}`);

        const model = language === "he" ? "openai/whisper-small" : "openai/whisper-base";
        logWithTime(`🤖 Model: ${model}`);

        const readTimer = timeStart("Reading audio file");
        const audioBytes = fs.readFileSync(audioFile);
        const fileSize = (audioBytes.length / 1024).toFixed(2);
        readTimer();
        logWithTime(`📁 Audio file size: ${fileSize} KB`);

        const headers = {};
        if (hfToken) {
            headers['Authorization'] = `Bearer ${hfToken}`;
        }

        const apiTimer = timeStart("Hugging Face API call");
        logWithTime(`🌐 API URL: https://api-inference.huggingface.co/models/${model}`);

        const response = await fetch(
            `https://api-inference.huggingface.co/models/${model}`, {
                method: 'POST',
                headers: headers,
                body: audioBytes,
            }
        );

        const apiDuration = apiTimer();
        logWithTime(`📡 API Response status: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            if (response.status === 503) {
                const errorData = await response.json().catch(() => ({}));
                const estimatedTime = errorData.estimated_time || 10;
                logWithTime(`⏳ Model is loading, estimated wait time: ${estimatedTime}s`);
                await sleep(estimatedTime * 1000);
                timer();
                return await transcribeWithHuggingFace(audioFile, language);
            }
            const errorText = await response.text();
            logWithTime(`❌ API Error: ${response.status} - ${errorText}`);
            timer();
            throw new Error(`Hugging Face STT error: ${response.status} - ${errorText}`);
        }

        const parseTimer = timeStart("Parsing API response");
        const data = await response.json();
        parseTimer();

        const transcription = data.text || (data[0] && data[0].text) || (Array.isArray(data) && data[0] && data[0].transcription);

        if (transcription) {
            const totalDuration = timer();
            logWithTime("✅ SUCCESS: Hugging Face Whisper transcription completed");
            logWithTime(`📝 TRANSCRIPTION TEXT: "${transcription}"`);
            logWithTime(`📊 Total transcription time: ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s)`);
            return transcription;
        }

        timer();
        logWithTime("⚠️ No transcription found in response");
        logWithTime("📦 Full API response:", data);
        return null;
    } catch (err) {
        timer();
        logWithTime(`🚨 ERROR: Hugging Face STT failed - ${err.message}`);
        logWithTime("📚 Error stack:", err.stack);
        return null;
    }
}

/* ---------- Twilio recording -> Whisper (HE) ---------- */
async function transcribeAudioFromTwilio(recordingUrl) {
    const totalTimer = timeStart("Complete Transcription Process");
    try {
        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime("🎙️ STARTING TRANSCRIPTION");
        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime(`🔗 Recording URL: ${recordingUrl}`);

        const auth = Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString("base64");

        const url = `${recordingUrl}.wav`;
        logWithTime(`📥 Download URL: ${url}`);

        const downloadTimer = timeStart("Downloading recording from Twilio");
        const delays = [200, 400, 800]; // Très rapides pour minimiser la latence
        let resp;
        let downloadAttempts = 0;

        for (let attempt = 0; attempt < delays.length; attempt++) {
            downloadAttempts++;
            const attemptTimer = timeStart(`Download attempt ${downloadAttempts}`);
            resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
            attemptTimer();

            logWithTime(`📡 Download attempt ${downloadAttempts}/${delays.length} - Status: ${resp.status}`);

            if (resp.ok) {
                logWithTime("✅ Recording downloaded successfully");
                break;
            }

            if (attempt < delays.length - 1) {
                logWithTime(`⏳ Waiting ${delays[attempt]}ms before retry`);
                await sleep(delays[attempt]);
            }
        }

        const downloadDuration = downloadTimer();
        logWithTime(`📊 Download completed in ${downloadDuration}ms`);

        if (!resp || !resp.ok) {
            logWithTime(`❌ Failed to download recording after ${downloadAttempts} attempts`);
            totalTimer();
            throw new Error(`❌ Failed to download: ${resp?.status}`);
        }

        const saveTimer = timeStart("Saving recording to disk");
        const tempFile = path.join("/tmp", `recording-v2-${Date.now()}.wav`);
        const buffer = await resp.arrayBuffer();
        fs.writeFileSync(tempFile, Buffer.from(buffer));
        const fileSize = (buffer.byteLength / 1024).toFixed(2);
        saveTimer();
        logWithTime(`💾 Recording saved: ${tempFile}`);
        logWithTime(`📁 File size: ${fileSize} KB`);

        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime("🤗 USING HUGGING FACE WHISPER (FREE & FAST)");
        logWithTime("═══════════════════════════════════════════════════════");

        const transcription = await transcribeWithHuggingFace(tempFile, "he");

        const cleanupTimer = timeStart("Cleaning up temp file");
        fs.unlinkSync(tempFile);
        cleanupTimer();
        logWithTime("🗑️ Temp file deleted");

        const totalDuration = totalTimer();
        logWithTime("═══════════════════════════════════════════════════════");
        if (transcription) {
            logWithTime("✅ TRANSCRIPTION COMPLETED SUCCESSFULLY");
            logWithTime(`📝 FINAL TRANSCRIPTION: "${transcription}"`);
        } else {
            logWithTime("❌ TRANSCRIPTION FAILED - No result");
        }
        logWithTime(`⏱️ TOTAL PROCESS TIME: ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s)`);
        logWithTime("═══════════════════════════════════════════════════════");

        return transcription || "";
    } catch (err) {
        totalTimer();
        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime("🚨 TRANSCRIPTION PROCESS ERROR");
        logWithTime(`❌ Error: ${err.message}`);
        logWithTime("═══════════════════════════════════════════════════════");
        return "";
    }
}

/* ---------- Main Twilio Webhook ---------- */
export default async function handler(req, res) {
    const requestTimer = timeStart("Total Request Handler");

    logWithTime("═══════════════════════════════════════════════════════");
    logWithTime("🟢 NEW REQUEST");
    logWithTime("═══════════════════════════════════════════════════════");
    logWithTime("🔹 STEP:", req.query.step || "start");
    logWithTime("🔹 METHOD:", req.method);
    logWithTime("🔹 BODY keys:", Object.keys(req.body || {}));
    logWithTime("🔹 Query params:", req.query);

    if (req.method !== "POST") {
        logWithTime("❌ Method not allowed:", req.method);
        return res.status(405).send("Method Not Allowed");
    }

    const vr = new VoiceResponse();
    const step = req.query.step || "start";

    try {
        /* ---- STEP 1 : Language Selection ---- */
        if (step === "start") {
            logWithTime("📍 STEP 1: Language Selection");
            const gather = vr.gather({
                input: "speech dtmf",
                numDigits: 1,
                action: "https://dentist-ivr-poc.vercel.app/api/voice_v2?step=lang",
                method: "POST",
                speechTimeout: "auto",
                timeout: 10,
                bargeIn: true,
            });

            gather.say({ language: "en-US" }, "For service in English, press 1.");
            gather.say({ language: "fr-FR" }, "Pour le service en français, appuyez sur 2.");
            // Hébreu via MP3 pré-enregistré (Twilio ne supporte pas he-IL en TTS)
            gather.play("https://dentist-ivr-poc.vercel.app/audio/press-3-he.mp3");

            logWithTime("✅ Sending language selection TwiML");
            requestTimer();
            res.setHeader("Content-Type", "text/xml");
            res.send(vr.toString());
            return;
        }

        /* ---- STEP 2 : Ask Name + Date ---- */
        if (step === "lang") {
            logWithTime("📍 STEP 2: Language Selected, Asking for Name + Date");
            const digits = req.body.Digits;
            const speech = (req.body.SpeechResult || "").toLowerCase();
            logWithTime(`🔢 Digits: ${digits}`);
            logWithTime(`🗣️ Speech: ${speech}`);

            let key = "1"; // EN by default
            if (digits === "2" || speech.includes("fran")) key = "2";
            else if (digits === "3" || speech.includes("ivrit") || speech.includes("עברית")) key = "3";

            logWithTime(`🌍 Selected language: ${key === "1" ? "English" : key === "2" ? "French" : "Hebrew"}`);

            const langs = { "1": "en-US", "2": "fr-FR" };

            if (key === "3") {
                // Mode hébreu: on joue l'audio et on enregistre (pas de STT Twilio)
                logWithTime("🎵 Playing Hebrew welcome MP3");
                vr.play("https://dentist-ivr-poc.vercel.app/audio/welcome-he.mp3");
                vr.record({
                    action: `https://dentist-ivr-poc.vercel.app/api/voice_v2?step=collect&lang=3`,
                    method: "POST",
                    maxLength: "60",
                    timeout: "6",
                    trim: "do-not-trim",
                    playBeep: false,
                    finishOnKey: "#",
                });
                logWithTime("🎙️ Recording Hebrew audio for Whisper transcription");
            } else {
                // EN / FR : Gather STT Twilio
                const prompts = {
                    "1": "Welcome to Doctor B's clinic. Please say your name and the date and time you'd like for your appointment.",
                    "2": "Bienvenue au cabinet du docteur B. Veuillez indiquer votre nom ainsi que la date et l'heure souhaitées pour votre rendez-vous.",
                };

                logWithTime(`📢 Playing prompt: "${prompts[key]}"`);

                const gather = vr.gather({
                    input: "speech",
                    action: `https://dentist-ivr-poc.vercel.app/api/voice_v2?step=collect&lang=${key}`,
                    method: "POST",
                    language: langs[key],
                    speechTimeout: "auto",
                    timeout: 60,
                    bargeIn: true,
                });

                gather.say({ language: langs[key] }, prompts[key]);
                logWithTime("🎙️ Using Twilio STT for EN/FR");
            }

            logWithTime("✅ Sending name+date collection TwiML");
            requestTimer();
            res.setHeader("Content-Type", "text/xml");
            res.send(vr.toString());
            return;
        }

        /* ---- STEP 3 : Parse & Schedule ---- */
        if (step === "collect") {
            logWithTime("📍 STEP 3: Parsing Speech and Scheduling Appointment");
            const lang = req.query.lang || "1";
            let utterance = req.body.SpeechResult || "";
            const from = req.body.From || "";
            const recordingUrl = req.body.RecordingUrl;

            logWithTime(`🌍 Language: ${lang === "1" ? "English" : lang === "2" ? "French" : "Hebrew"}`);
            logWithTime(`📞 From: ${from}`);
            logWithTime(`🎙️ Recording URL: ${recordingUrl || "N/A"}`);
            logWithTime(`🗣️ Initial utterance (Twilio STT): "${utterance}"`);

            if (lang === "3" && recordingUrl) {
                logWithTime("🎙️ Hebrew mode — fetching & transcribing with Hugging Face Whisper…");
                utterance = await transcribeAudioFromTwilio(recordingUrl);
            }

            if (!utterance) {
                logWithTime("⚠️ No speech detected / transcription failed");
                vr.say({ language: "en-US" },
                    "Sorry, I could not understand your message. Please try again later."
                );
                requestTimer();
                res.setHeader("Content-Type", "text/xml");
                res.send(vr.toString());
                return;
            }

            logWithTime(`🧠 Final extracted speech: "${utterance}"`);

            let whenISO, name;
            const currentYear = new Date().getFullYear();

            try {
                const gptTimer = timeStart("GPT-4o-mini parsing");
                const sysPrompt =
                    lang === "3" ?
                    `אתה עוזר קביעת תורים רפואיים. מתוך המשפט של המטופל, הפק *שם מלא* ו-*תאריך מדויק* (כולל שעה אם קיימת).
הנח שהשנה הנוכחית היא ${currentYear} אם לא צוין אחרת. החזר JSON תקין בלבד:
{"date_iso":"YYYY-MM-DDTHH:mm:ssZ","name":"שם המטופל"}.` :
                    `You are a medical appointment assistant.
Extract the patient's *full name* and the *exact date and time* from the sentence.
If no year is provided, assume it is ${currentYear}.
Return strict JSON only:
{"date_iso":"YYYY-MM-DDTHH:mm:ssZ","name":"Patient name"}.`;

                logWithTime("🤖 Calling GPT-4o-mini for parsing...");
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: sysPrompt },
                        { role: "user", content: utterance },
                    ],
                    temperature: 0.1,
                });

                gptTimer();
                const data = JSON.parse(completion.choices[0].message.content.trim());
                whenISO = data.date_iso;
                name = data.name || "Patient";

                logWithTime(`✅ GPT Parsed - Name: "${name}", Date: "${whenISO}"`);

                // Sécurité : remet l'année courante si le modèle renvoie une année passée
                const d = new Date(whenISO);
                if (d.getFullYear() < currentYear) {
                    logWithTime(`⚠️ Adjusting year from ${d.getFullYear()} to ${currentYear}`);
                    d.setFullYear(currentYear);
                    whenISO = d.toISOString();
                }
            } catch (e) {
                logWithTime("⚠️ OpenAI parsing error:", e.message);
                // Fallback: chrono pour EN/FR ; sinon valeur par défaut (J+1)
                const parsed =
                    lang === "1" || lang === "2" ?
                    chrono.parseDate(utterance, new Date(), { forwardDate: true }) :
                    null;

                whenISO = parsed ?
                    parsed.toISOString() :
                    new Date(Date.now() + 24 * 3600 * 1000).toISOString();
                name = "Patient";
                logWithTime(`⚠️ Fallback parsing - Name: "${name}", Date: "${whenISO}"`);
            }

            try {
                await createCalendarEvent({
                    summary: `${process.env.CLINIC_NAME} – RDV ${name}`,
                    startISO: whenISO,
                    minutes: parseInt(process.env.DEFAULT_APPT_MINUTES || "30", 10),
                    phone: from,
                });

                if (lang === "3") {
                    // Confirmation audio pré-enregistrée en hébreu
                    logWithTime("📢 Playing Hebrew confirmation MP3");
                    vr.play("https://dentist-ivr-poc.vercel.app/audio/confirm-he.mp3");
                    const localized = new Date(whenISO).toLocaleString("en-US", {
                        timeZone: process.env.CLINIC_TIMEZONE,
                    });
                    vr.say({
                            language: "en-US",
                            voice: "Polly.Joanna",
                        },
                        `Appointment confirmed. Date and time ${localized}.`
                    );
                    logWithTime(`📢 Confirmation message: "Appointment confirmed. Date and time ${localized}."`);
                } else {
                    const msgs = {
                        "1": `Thank you ${name}. Your appointment has been scheduled for ${new Date(
              whenISO
            ).toLocaleString("en-US", { timeZone: process.env.CLINIC_TIMEZONE })}. Goodbye!`,
                        "2": `Merci ${name}. Votre rendez-vous a bien été enregistré pour le ${new Date(
              whenISO
            ).toLocaleString("fr-FR", { timeZone: process.env.CLINIC_TIMEZONE })}. À bientôt !`,
                    };
                    logWithTime(`📢 Confirmation message: "${msgs[lang]}"`);
                    vr.say({ language: { "1": "en-US", "2": "fr-FR" }[lang] }, msgs[lang]);
                }
            } catch (err) {
                logWithTime("❌ Calendar error:", err.message);
                vr.say({ language: "en-US" },
                    "Sorry, there was an issue scheduling your appointment."
                );
            }

            const totalRequestDuration = requestTimer();
            logWithTime("═══════════════════════════════════════════════════════");
            logWithTime("✅ REQUEST COMPLETED");
            logWithTime(`⏱️ TOTAL REQUEST TIME: ${totalRequestDuration}ms (${(totalRequestDuration/1000).toFixed(2)}s)`);
            logWithTime("═══════════════════════════════════════════════════════");

            res.setHeader("Content-Type", "text/xml");
            res.send(vr.toString());
            return;
        }
    } catch (err) {
        requestTimer();
        logWithTime("🔥 FATAL ERROR:", err.message, err.stack);
        const fallback = new VoiceResponse();
        fallback.say({ language: "en-US" }, "Sorry, something went wrong on our end.");
        res.setHeader("Content-Type", "text/xml");
        res.send(fallback.toString());
    }
}