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

// Helper pour logs avec timestamp
const logWithTime = (message, data = null) => {
    const timestamp = new Date().toISOString();
    const time = new Date().toLocaleTimeString('fr-FR', { hour12: false, fractionalSecondDigits: 3 });
    if (data !== null) {
        console.log(`[${time}] [V2] ${message}`, data);
    } else {
        console.log(`[${time}] [V2] ${message}`);
    }
};

// Helper pour mesurer le temps
const timeStart = (label) => {
    const start = Date.now();
    logWithTime(`⏱️ START: ${label}`);
    return () => {
        const duration = Date.now() - start;
        logWithTime(`⏱️ END: ${label} - Duration: ${duration}ms (${(duration/1000).toFixed(2)}s)`);
        return duration;
    };
};

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
    const endTimer = timeStart("Hugging Face Whisper Transcription");
    try {
        logWithTime("🤗 METHOD: Hugging Face Whisper (open source)");
        logWithTime(`📋 Language: ${language === "he" ? "Hebrew" : "English"}`);
        
        // Hugging Face API key optionnelle (gratuit sans clé mais avec rate limit)
        const hfToken = process.env.HUGGINGFACE_API_KEY || "";
        const hasToken = !!hfToken;
        logWithTime(`🔑 API Key: ${hasToken ? "✅ Present" : "⚠️ Not set (using free tier with rate limit)"}`);
        
        const model = language === "he" ? "openai/whisper-small" : "openai/whisper-base";
        logWithTime(`🤖 Model: ${model}`);
        
        // Lire le fichier audio
        const readTimer = timeStart("Reading audio file");
        const audioBytes = fs.readFileSync(audioFile);
        const fileSize = (audioBytes.length / 1024).toFixed(2);
        readTimer();
        logWithTime(`📁 Audio file size: ${fileSize} KB`);
        
        const headers = {};
        if (hfToken) {
            headers['Authorization'] = `Bearer ${hfToken}`;
        }

        // Hugging Face Inference API accepte directement les bytes audio
        const apiTimer = timeStart("Hugging Face API call");
        logWithTime(`🌐 API URL: https://api-inference.huggingface.co/models/${model}`);
        
        const response = await fetch(
            `https://api-inference.huggingface.co/models/${model}`,
            {
                method: 'POST',
                headers: headers,
                body: audioBytes,
            }
        );
        
        const apiDuration = apiTimer();
        logWithTime(`📡 API Response status: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            // Si le modèle est en train de charger, attendre un peu
            if (response.status === 503) {
                const errorData = await response.json().catch(() => ({}));
                const estimatedTime = errorData.estimated_time || 10;
                logWithTime(`⏳ Model is loading, estimated wait time: ${estimatedTime}s`);
                await sleep(estimatedTime * 1000);
                endTimer();
                return await transcribeWithHuggingFace(audioFile, language);
            }
            const errorText = await response.text();
            logWithTime(`❌ API Error: ${response.status} - ${errorText}`);
            endTimer();
            throw new Error(`Hugging Face STT error: ${response.status} - ${errorText}`);
        }

        const parseTimer = timeStart("Parsing API response");
        const data = await response.json();
        parseTimer();
        
        // Le format de réponse peut varier selon le modèle
        const transcription = data.text || data[0]?.text || (Array.isArray(data) && data[0]?.transcription);
        
        if (transcription) {
            const totalDuration = endTimer();
            logWithTime("✅ SUCCESS: Hugging Face Whisper transcription completed");
            logWithTime(`📝 TRANSCRIPTION TEXT: "${transcription}"`);
            logWithTime(`📊 Total transcription time: ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s)`);
            return transcription;
        }
        
        endTimer();
        logWithTime("⚠️ No transcription found in response");
        logWithTime("📦 Full API response:", data);
        return null;
    } catch (err) {
        endTimer();
        logWithTime(`🚨 ERROR: Hugging Face STT failed - ${err.message}`);
        logWithTime("📚 Error stack:", err.stack);
        return null;
    }
}

/**
 * Méthode 2: Gladia API (open source, gratuit avec plan free)
 * Supporte hébreu et anglais
 */
async function transcribeWithGladia(audioFile, language = "he") {
    const endTimer = timeStart("Gladia API Transcription");
    try {
        logWithTime("🎯 METHOD: Gladia API (open source)");
        logWithTime(`📋 Language: ${language === "he" ? "Hebrew" : "English"}`);
        
        const gladiaKey = process.env.GLADIA_API_KEY || "";
        if (!gladiaKey) {
            logWithTime("⚠️ GLADIA_API_KEY not set, skipping Gladia");
            endTimer();
            return null;
        }
        logWithTime("🔑 API Key: ✅ Present");

        // Lire le fichier audio
        const readTimer = timeStart("Reading audio file for Gladia");
        const audioBytes = fs.readFileSync(audioFile);
        const fileSize = (audioBytes.length / 1024).toFixed(2);
        readTimer();
        logWithTime(`📁 Audio file size: ${fileSize} KB`);
        
        const encodeTimer = timeStart("Encoding audio to base64");
        const base64Audio = audioBytes.toString('base64');
        const base64Size = (base64Audio.length / 1024).toFixed(2);
        encodeTimer();
        logWithTime(`📦 Base64 size: ${base64Size} KB`);

        // Upload audio
        const uploadTimer = timeStart("Gladia audio upload");
        logWithTime("🌐 Uploading to: https://api.gladia.io/v2/upload");
        
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
        
        const uploadDuration = uploadTimer();
        logWithTime(`📡 Upload response: ${uploadResponse.status} ${uploadResponse.statusText}`);

        if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            logWithTime(`❌ Upload error: ${uploadResponse.status} - ${errorText}`);
            endTimer();
            throw new Error(`Gladia upload error: ${uploadResponse.status}`);
        }

        const uploadData = await uploadResponse.json();
        const audioUrl = uploadData.audio_url;
        logWithTime(`✅ Audio uploaded successfully`);
        logWithTime(`🔗 Audio URL: ${audioUrl}`);

        // Transcribe
        const transcribeTimer = timeStart("Gladia transcription request");
        logWithTime("🌐 Requesting transcription: https://api.gladia.io/v2/transcription");
        logWithTime(`🌍 Language setting: ${language === "he" ? "hebrew" : "english"}`);
        
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
        
        transcribeTimer();
        logWithTime(`📡 Transcription request response: ${transcribeResponse.status} ${transcribeResponse.statusText}`);

        if (!transcribeResponse.ok) {
            const errorText = await transcribeResponse.text();
            logWithTime(`❌ Transcription request error: ${transcribeResponse.status} - ${errorText}`);
            endTimer();
            throw new Error(`Gladia transcription error: ${transcribeResponse.status}`);
        }

        const transcribeData = await transcribeResponse.json();
        const transcriptionId = transcribeData.id;
        logWithTime(`✅ Transcription job created`);
        logWithTime(`🆔 Transcription ID: ${transcriptionId}`);
        
        // Polling pour obtenir le résultat
        const pollingTimer = timeStart("Gladia polling for results");
        let result = null;
        let attempts = 0;
        logWithTime("🔄 Starting polling for transcription results...");
        
        while (attempts < 30) {
            const statusTimer = timeStart(`Poll attempt ${attempts + 1}`);
            const statusResponse = await fetch(
                `https://api.gladia.io/v2/transcription/${transcriptionId}`,
                {
                    headers: { 'x-gladia-key': gladiaKey },
                }
            );
            statusTimer();
            
            const statusData = await statusResponse.json();
            logWithTime(`📊 Poll ${attempts + 1}/30 - Status: ${statusData.status}`);
            
            if (statusData.status === 'done') {
                result = statusData.result?.transcription_full?.text || 
                         statusData.result?.transcription?.map(t => t.text).join(' ') || '';
                logWithTime("✅ Transcription completed!");
                break;
            }
            if (statusData.status === 'error') {
                logWithTime(`❌ Transcription failed: ${statusData.error || 'Unknown error'}`);
                endTimer();
                throw new Error('Gladia transcription failed');
            }
            if (statusData.status === 'processing') {
                logWithTime("⏳ Still processing...");
            }
            
            await sleep(1000);
            attempts++;
        }
        
        const pollingDuration = pollingTimer();
        logWithTime(`🔄 Polling completed after ${attempts} attempts (${pollingDuration}ms)`);

        if (result) {
            const totalDuration = endTimer();
            logWithTime("✅ SUCCESS: Gladia transcription completed");
            logWithTime(`📝 TRANSCRIPTION TEXT: "${result}"`);
            logWithTime(`📊 Total transcription time: ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s)`);
            return result;
        }
        
        endTimer();
        logWithTime("⚠️ No transcription result after polling");
        return null;
    } catch (err) {
        endTimer();
        logWithTime(`🚨 ERROR: Gladia transcription failed - ${err.message}`);
        logWithTime("📚 Error stack:", err.stack);
        return null;
    }
}

/**
 * Méthode 3: OpenAI Whisper (fallback si open source échoue)
 */
async function transcribeWithOpenAIWhisper(audioFile, language = "he") {
    const endTimer = timeStart("OpenAI Whisper Transcription");
    try {
        logWithTime("📤 METHOD: OpenAI Whisper (fallback)");
        logWithTime(`📋 Language: ${language === "he" ? "Hebrew" : "English"}`);
        logWithTime(`🤖 Model: gpt-4o-mini-transcribe`);
        
        const fileStats = fs.statSync(audioFile);
        const fileSize = (fileStats.size / 1024).toFixed(2);
        logWithTime(`📁 Audio file size: ${fileSize} KB`);
        
        const apiTimer = timeStart("OpenAI API call");
        logWithTime("🌐 Calling OpenAI Whisper API...");
        
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioFile),
            model: "gpt-4o-mini-transcribe",
            response_format: "json",
            language: language,
            prompt: language === "he" 
                ? "שיחה לקביעת תור אצל רופא שיניים. שמות פרטיים ומשפחה בעברית, תאריכים ושעות בדיוק."
                : "Medical appointment booking conversation. Patient names, dates and times.",
        });
        
        const apiDuration = apiTimer();
        logWithTime(`📡 API call completed in ${apiDuration}ms`);
        
        const totalDuration = endTimer();
        logWithTime("✅ SUCCESS: OpenAI Whisper transcription completed");
        logWithTime(`📝 TRANSCRIPTION TEXT: "${transcription.text}"`);
        logWithTime(`📊 Total transcription time: ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s)`);
        
        return transcription.text || "";
    } catch (err) {
        endTimer();
        logWithTime(`🚨 ERROR: OpenAI Whisper failed - ${err.message}`);
        logWithTime("📚 Error stack:", err.stack);
        return "";
    }
}

/**
 * Transcription optimisée avec fallback automatique
 */
async function transcribeAudioFromTwilio(recordingUrl) {
    const totalTimer = timeStart("Complete Transcription Process");
    try {
        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime("🎙️ STARTING TRANSCRIPTION PROCESS");
        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime(`🔗 Recording URL: ${recordingUrl}`);

        const auth = Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString("base64");

        // Optimisé: télécharger en WAV avec retry rapide
        const url = `${recordingUrl}.wav`;
        logWithTime(`📥 Download URL: ${url}`);
        
        const downloadTimer = timeStart("Downloading recording from Twilio");
        const delays = [300, 500, 1000, 2000];
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
            
            logWithTime(`⏳ Recording not ready (status ${resp.status}), waiting ${delays[attempt]}ms before retry`);
            if (attempt < delays.length - 1) {
                await sleep(delays[attempt]);
            }
        }
        
        const downloadDuration = downloadTimer();
        logWithTime(`📊 Download completed in ${downloadDuration}ms (${(downloadDuration/1000).toFixed(2)}s)`);

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

        // Essayer les solutions open source d'abord, puis fallback vers OpenAI
        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime("🔄 STARTING TRANSCRIPTION ATTEMPTS");
        logWithTime("═══════════════════════════════════════════════════════");
        
        // 1. Hugging Face Whisper (gratuit, open source)
        logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        logWithTime("📍 ATTEMPT 1/3: Hugging Face Whisper");
        logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        let transcription = await transcribeWithHuggingFace(tempFile, "he");
        
        // 2. Gladia (si Hugging Face échoue)
        if (!transcription) {
            logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            logWithTime("📍 ATTEMPT 2/3: Gladia API");
            logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            transcription = await transcribeWithGladia(tempFile, "he");
        }
        
        // 3. OpenAI Whisper (fallback final)
        if (!transcription) {
            logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            logWithTime("📍 ATTEMPT 3/3: OpenAI Whisper (fallback)");
            logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            transcription = await transcribeWithOpenAIWhisper(tempFile, "he");
        }

        const cleanupTimer = timeStart("Cleaning up temp file");
        fs.unlinkSync(tempFile);
        cleanupTimer();
        logWithTime("🗑️ Temp file deleted");

        const totalDuration = totalTimer();
        logWithTime("═══════════════════════════════════════════════════════");
        if (transcription) {
            logWithTime("✅ TRANSCRIPTION PROCESS COMPLETED SUCCESSFULLY");
            logWithTime(`📝 FINAL TRANSCRIPTION: "${transcription}"`);
        } else {
            logWithTime("❌ TRANSCRIPTION PROCESS FAILED - No result");
        }
        logWithTime(`⏱️ TOTAL PROCESS TIME: ${totalDuration}ms (${(totalDuration/1000).toFixed(2)}s)`);
        logWithTime("═══════════════════════════════════════════════════════");
        
        return transcription || "";
    } catch (err) {
        totalTimer();
        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime("🚨 TRANSCRIPTION PROCESS ERROR");
        logWithTime(`❌ Error: ${err.message}`);
        logWithTime("📚 Error stack:", err.stack);
        logWithTime("═══════════════════════════════════════════════════════");
        return "";
    }
}

/* ---------- Main Twilio Webhook ---------- */
export default async function handler(req, res) {
    const requestTimer = timeStart("Request Processing");
    logWithTime("═══════════════════════════════════════════════════════");
    logWithTime("🟢 NEW REQUEST RECEIVED");
    logWithTime("═══════════════════════════════════════════════════════");
    logWithTime(`📋 STEP: ${req.query.step || "start"}`);
    logWithTime(`📦 BODY keys: ${Object.keys(req.body || {}).join(", ")}`);
    logWithTime(`📞 From: ${req.body.From || "N/A"}`);
    logWithTime(`🔗 Recording URL: ${req.body.RecordingUrl || "N/A"}`);
    logWithTime(`💬 Speech Result: ${req.body.SpeechResult || "N/A"}`);

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
                logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                logWithTime("🇮🇱 HEBREW MODE DETECTED");
                logWithTime("🎙️ Starting transcription with open source STT…");
                logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                utterance = await transcribeAudioFromTwilio(recordingUrl);
                
                if (utterance) {
                    logWithTime("✅ Transcription successful for Hebrew");
                } else {
                    logWithTime("❌ Transcription failed for Hebrew");
                }
            } else if (lang !== "3") {
                logWithTime(`🌍 Language: ${lang === "1" ? "English" : "French"}`);
                logWithTime("💬 Using Twilio STT (built-in)");
                logWithTime(`📝 Twilio Speech Result: "${utterance}"`);
            }
            
            // Pour EN/FR: on garde STT Twilio (déjà rapide et gratuit)
            // Mais on pourrait aussi utiliser l'enregistrement + transcription open source si besoin

            if (!utterance) {
                logWithTime("⚠️ WARNING: No speech detected / transcription failed");
                vr.say({ language: "en-US" },
                    "Sorry, I could not understand your message. Please try again later."
                );
                res.setHeader("Content-Type", "text/xml");
                res.send(vr.toString());
                return;
            }

            logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            logWithTime("🧠 EXTRACTED SPEECH/TRANSCRIPTION");
            logWithTime(`📝 Text: "${utterance}"`);
            logWithTime("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

            let whenISO, name;
            const currentYear = new Date().getFullYear();

            try {
                const parseTimer = timeStart("Parsing with GPT-4o-mini");
                logWithTime("🤖 Starting GPT-4o-mini extraction...");
                
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

                logWithTime(`📋 System prompt length: ${sysPrompt.length} chars`);
                logWithTime(`📝 User content length: ${utterance.length} chars`);

                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: sysPrompt },
                        { role: "user", content: utterance },
                    ],
                    temperature: 0.1,
                });
                
                const parseDuration = parseTimer();
                logWithTime(`✅ GPT extraction completed in ${parseDuration}ms`);
                logWithTime(`📦 GPT Response: ${completion.choices[0].message.content}`);

                const data = JSON.parse(completion.choices[0].message.content.trim());
                whenISO = data.date_iso;
                name = data.name || "Patient";
                
                logWithTime(`📅 Extracted date: ${whenISO}`);
                logWithTime(`👤 Extracted name: ${name}`);

                // Sécurité : remet l'année courante si le modèle renvoie une année passée
                const d = new Date(whenISO);
                if (d.getFullYear() < currentYear) {
                    d.setFullYear(currentYear);
                    whenISO = d.toISOString();
                }
            } catch (e) {
                logWithTime(`⚠️ ERROR: OpenAI parsing failed - ${e.message}`);
                logWithTime("📚 Error stack:", e.stack);
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
                const calendarTimer = timeStart("Creating calendar event");
                logWithTime("📅 Creating calendar event...");
                logWithTime(`📋 Summary: ${process.env.CLINIC_NAME} – RDV ${name}`);
                logWithTime(`📅 Start: ${whenISO}`);
                logWithTime(`⏱️ Duration: ${parseInt(process.env.DEFAULT_APPT_MINUTES || "30", 10)} minutes`);
                logWithTime(`📞 Phone: ${from}`);
                
                await createCalendarEvent({
                    summary: `${process.env.CLINIC_NAME} – RDV ${name}`,
                    startISO: whenISO,
                    minutes: parseInt(process.env.DEFAULT_APPT_MINUTES || "30", 10),
                    phone: from,
                });
                
                const calendarDuration = calendarTimer();
                logWithTime(`✅ Calendar event created in ${calendarDuration}ms`);

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
                logWithTime(`❌ ERROR: Calendar creation failed - ${err.message}`);
                logWithTime("📚 Error stack:", err.stack);
                vr.say({ language: "en-US" },
                    "Sorry, there was an issue scheduling your appointment."
                );
            }

            const requestDuration = requestTimer();
            logWithTime("═══════════════════════════════════════════════════════");
            logWithTime("✅ REQUEST COMPLETED SUCCESSFULLY");
            logWithTime(`⏱️ Total request time: ${requestDuration}ms (${(requestDuration/1000).toFixed(2)}s)`);
            logWithTime("═══════════════════════════════════════════════════════");
            
            res.setHeader("Content-Type", "text/xml");
            res.send(vr.toString());
            return;
        }
    } catch (err) {
        requestTimer();
        logWithTime("═══════════════════════════════════════════════════════");
        logWithTime("🔥 FATAL ERROR");
        logWithTime(`❌ Error: ${err.message}`);
        logWithTime("📚 Error stack:", err.stack);
        logWithTime("═══════════════════════════════════════════════════════");
        const fallback = new VoiceResponse();
        fallback.say({ language: "en-US" }, "Sorry, something went wrong on our end.");
        res.setHeader("Content-Type", "text/xml");
        res.send(fallback.toString());
    }
}

