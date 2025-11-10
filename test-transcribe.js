import "dotenv/config";  // <== charge ton fichier .env automatiquement
import OpenAI from "openai";
import fs from "fs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const transcription = await openai.audio.transcriptions.create({
  model: "gpt-4o-mini-transcribe",
  file: fs.createReadStream("./public/audio/test-hebrew.mp3"),
  language: "he",
});

console.log("🗣️ Result:", transcription.text);
