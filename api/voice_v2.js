// api/voice_v2.js - Version de test avec transcription alternative
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

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ---------- Transcription open source pour hébreu/anglais ---------- */

/**
 * Méthode 1: Hugging Face Inference API (Whisper open source, gratuit)
 * Modèles disponibles: openai/whisper-base, openai/whisper-small, openai/whisper-medium
 */
async function transcribeWithHuggingFace(audioFile, language = "he") {
    try {
        console.log("🤗 Trying Hugging Face Whisper (open source)...");

        // Hugging Face API key optionnelle (gratuit sans clé mais avec rate limit)
        const hfToken = process.env.HUGGINGFACE_API_KEY || "";
        const model = language === "he" ? "openai/whisper-small" : "openai/whisper-base";

        // Lire le fichier audio
        const audioBytes = fs.readFileSync(audioFile);

        const headers = {};
        if (hfToken) {
            headers['Authorization'] = `Bearer ${hfToken}`;
        }

        // Hugging Face Inference API accepte directement les bytes audio
        const response = await fetch(
            `https://api-inference.huggingface.co/models/${model}`, {
                method: 'POST',
                headers: headers,
                body: audioBytes,
            }
        );

        if (!response.ok) {
            // Si le modèle est en train de charger, attendre un peu
            if (response.status === 503) {
                const errorData = await response.json().catch(() => ({}));
                const estimatedTime = errorData.estimated_time || 10;
                console.log(`⏳ Model loading, waiting ${estimatedTime}s...`);
                await sleep(estimatedTime * 1000);
                return await transcribeWithHuggingFace(audioFile, language);
            }
            const errorText = await response.text();
            throw new Error(`Hugging Face STT error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        // Le format de réponse peut varier selon le modèle
        const transcription = data.text || data[0] ? .text || (Array.isArray(data) && data[0] ? .transcription);

        if (transcription) {
            console.log("✅ Hugging Face Whisper result:", transcription);
            return transcription;
        }
        return null;
    } catch (err) {
        console.error("🚨 Hugging Face STT error:", err.message);
        return null;
    }
}

/**
 * Méthode 2: Gladia API (open source, gratuit avec plan free)
 * Supporte hébreu et anglais
 */
async function transcribeWithGladia(audioFile, language = "he") {
    try {
        console.log("🎯 Trying Gladia API (open source)...");

        const gladiaKey = process.env.GLADIA_API_KEY || "";
        if (!gladiaKey) {
            console.log("⚠️ GLADIA_API_KEY not set, skipping Gladia");
            return null;
        }

        // Lire le fichier audio
        const audioBytes = fs.readFileSync(audioFile);
        const base64Audio = audioBytes.toString('base64');

        // Upload audio
        const uploadResponse = await fetch('https://api.gladia.io/v2/upload', {
            method: 'POST',
            headers: {
                'x-gladia-key': gladiaKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                audio: base64Audio,
            }),
        });

        if (!uploadResponse.ok) {
            throw new Error(`Gladia upload error: ${uploadResponse.status}`);
        }

        const uploadData = await uploadResponse.json();
        const audioUrl = uploadData.audio_url;

        // Transcribe
        const transcribeResponse = await fetch('https://api.gladia.io/v2/transcription', {
            method: 'POST',
            headers: {
                'x-gladia-key': gladiaKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                audio_url: audioUrl,
                language: language === "he" ? "hebrew" : "english",
                toggle_diarization: false,
            }),
        });

        if (!transcribeResponse.ok) {
            throw new Error(`Gladia transcription error: ${transcribeResponse.status}`);
        }

        const transcribeData = await transcribeResponse.json();

        // Polling pour obtenir le résultat
        let result = null;
        let attempts = 0;
        while (attempts < 30) {
            const statusResponse = await fetch(
                `https://api.gladia.io/v2/transcription/${transcribeData.id}`, {
                    headers: { 'x-gladia-key': gladiaKey },
                }
            );
            const statusData = await statusResponse.json();

            if (statusData.status === 'done') {
                result = statusData.result ? .transcription_full ? .text ||
                    statusData.result ? .transcription ? .map(t => t.text).join(' ') || '';
                break;
            }
            if (statusData.status === 'error') {
                throw new Error('Gladia transcription failed');
            }
            await sleep(1000);
            attempts++;
        }

        if (result) {
            console.log("✅ Gladia result:", result);
            return result;
        }
        return null;
    } catch (err) {
        console.error("🚨 Gladia error:", err.message);
        return null;
    }
}

/**
 * Méthode 3: OpenAI Whisper (fallback si open source échoue)
 */
async function transcribeWithOpenAIWhisper(audioFile, language = "he") {
    try {
        console.log("📤 Falling back to OpenAI Whisper...");
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioFile),
            model: "gpt-4o-mini-transcribe",
            response_format: "json",
            language: language,
            prompt: language === "he" ?
                "שיחה לקביעת תור אצל רופא שיניים. שמות פרטיים ומשפחה בעברית, תאריכים ושעות בדיוק." :
                "Medical appointment booking conversation. Patient names, dates and times.",
        });
        console.log("✅ OpenAI Whisper result:", transcription.text);
        return transcription.text || "";
    } catch (err) {
        console.error("🚨 OpenAI Whisper error:", err.message);
        return "";
    }
}

/**
 * Transcription optimisée avec fallback automatique
 */
async function transcribeAudioFromTwilio(recordingUrl) {
    try {
        console.log("🎧 Downloading Twilio recording base URL:", recordingUrl);

        const auth = Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString("base64");

        // Optimisé: télécharger en WAV avec retry rapide
        const url = `${recordingUrl}.wav`;
        const delays = [300, 500, 1000, 2000];
        let resp;
        for (let attempt = 0; attempt < delays.length; attempt++) {
            resp = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
            if (resp.ok) break;
            console.warn(
                `⏳ Recording not ready (status ${resp.status}), retry ${attempt + 1}/${delays.length}`
            );
            if (attempt < delays.length - 1) {
                await sleep(delays[attempt]);
            }
        }

        if (!resp || !resp.ok) {
            throw new Error(`❌ Failed to download: ${resp?.status}`);
        }

        const tempFile = path.join("/tmp", `recording-v2-${Date.now()}.wav`);
        const buffer = await resp.arrayBuffer();
        fs.writeFileSync(tempFile, Buffer.from(buffer));
        console.log("📥 Recording saved locally:", tempFile);

        // Essayer les solutions open source d'abord, puis fallback vers OpenAI
        // 1. Hugging Face Whisper (gratuit, open source)
        let transcription = await transcribeWithHuggingFace(tempFile, "he");

        // 2. Gladia (si Hugging Face échoue)
        if (!transcription) {
            console.log("🔄 Trying Gladia API...");
            transcription = await transcribeWithGladia(tempFile, "he");
        }

        // 3. OpenAI Whisper (fallback final)
        if (!transcription) {
            console.log("🔄 Falling back to OpenAI Whisper...");
            transcription = await transcribeWithOpenAIWhisper(tempFile, "he");
        }

        fs.unlinkSync(tempFile);
        return transcription || "";
    } catch (err) {
        console.error("🚨 Transcription error:", err.message);
        return "";
    }
}

/* ---------- Main Twilio Webhook ---------- */
export default async function handler(req, res) {
    console.log("🟢 [V2] STEP:", req.query.step || "start");
    console.log("🟡 [V2] BODY keys:", Object.keys(req.body || {}));

    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const vr = new VoiceResponse();
    const step = req.query.step || "start";

    try {
        /* ---- STEP 1 : Language Selection ---- */
        if (step === "start") {
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
            // Hébreu via MP3 pré-enregistré
            gather.play("https://dentist-ivr-poc.vercel.app/audio/press-3-he.mp3");

            res.setHeader("Content-Type", "text/xml");
            res.send(vr.toString());
            return;
        }

        /* ---- STEP 2 : Ask Name + Date ---- */
        if (step === "lang") {
            const digits = req.body.Digits;
            const speech = (req.body.SpeechResult || "").toLowerCase();

            let key = "1"; // EN by default
            if (digits === "2" || speech.includes("fran")) key = "2";
            else if (digits === "3" || speech.includes("ivrit") || speech.includes("עברית")) key = "3";

            const langs = { "1": "en-US", "2": "fr-FR" };

            if (key === "3") {
                // Mode hébreu: on joue l'audio et on enregistre (pas de STT Twilio)
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
            } else {
                // EN / FR : On peut aussi utiliser l'enregistrement + transcription open source
                // Pour l'instant, on garde STT Twilio pour EN/FR (rapide et gratuit)
                // Mais on pourrait switcher vers Hugging Face/Gladia si besoin
                const prompts = {
                    "1": "Welcome to Doctor B's clinic. Please say your name and the date and time you'd like for your appointment.",
                    "2": "Bienvenue au cabinet du docteur B. Veuillez indiquer votre nom ainsi que la date et l'heure souhaitées pour votre rendez-vous.",
                };

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
            }

            res.setHeader("Content-Type", "text/xml");
            res.send(vr.toString());
            return;
        }

        /* ---- STEP 3 : Parse & Schedule ---- */
        if (step === "collect") {
            const lang = req.query.lang || "1";
            let utterance = req.body.SpeechResult || "";
            const from = req.body.From || "";
            const recordingUrl = req.body.RecordingUrl;

            // Pour hébreu: utiliser transcription open source
            if (lang === "3" && recordingUrl) {
                console.log("🎙️ [V2] Hebrew mode — fetching & transcribing with open source STT…");
                utterance = await transcribeAudioFromTwilio(recordingUrl);
            }

            // Pour EN/FR: on garde STT Twilio (déjà rapide et gratuit)
            // Mais on pourrait aussi utiliser l'enregistrement + transcription open source si besoin

            if (!utterance) {
                console.warn("⚠️ No speech detected / transcription failed");
                vr.say({ language: "en-US" },
                    "Sorry, I could not understand your message. Please try again later."
                );
                res.setHeader("Content-Type", "text/xml");
                res.send(vr.toString());
                return;
            }

            console.log("🧠 [V2] Extracted speech:", utterance);

            let whenISO, name;
            const currentYear = new Date().getFullYear();

            try {
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

                // Sécurité : remet l'année courante si le modèle renvoie une année passée
                const d = new Date(whenISO);
                if (d.getFullYear() < currentYear) {
                    d.setFullYear(currentYear);
                    whenISO = d.toISOString();
                }
            } catch (e) {
                console.error("⚠️ OpenAI parsing error:", e.message);
                // Fallback: chrono pour EN/FR ; sinon valeur par défaut (J+1)
                const parsed =
                    lang === "1" || lang === "2" ?
                    chrono.parseDate(utterance, new Date(), { forwardDate: true }) :
                    null;

                whenISO = parsed ?
                    parsed.toISOString() :
                    new Date(Date.now() + 24 * 3600 * 1000).toISOString();
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
                    // Confirmation audio pré-enregistrée en hébreu
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
                vr.say({ language: "en-US" },
                    "Sorry, there was an issue scheduling your appointment."
                );
            }

            res.setHeader("Content-Type", "text/xml");
            res.send(vr.toString());
            return;
        }
    } catch (err) {
        console.error("🔥 [V2] FATAL ERROR:", err.message, err.stack);
        const fallback = new VoiceResponse();
        fallback.say({ language: "en-US" }, "Sorry, something went wrong on our end.");
        res.setHeader("Content-Type", "text/xml");
        res.send(fallback.toString());
    }
}