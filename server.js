import "dotenv/config";
import express from "express";

import twilio from "twilio";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const { jwt } = twilio;
const { AccessToken } = jwt;
const { VoiceGrant } = AccessToken;

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioApiKey = process.env.TWILIO_API_KEY;
const twilioApiSecret = process.env.TWILIO_API_SECRET;
const twimlAppSid = process.env.TWIML_APP_SID;

app.use(express.static(path.dirname(fileURLToPath(import.meta.url)))); // sert index.html

app.get("/token", (req, res) => {
  const identity = "browser_tester";
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: false,
  });

  const token = new AccessToken(
    twilioAccountSid,
    twilioApiKey,
    twilioApiSecret,
    { identity }
  );
  token.addGrant(voiceGrant);

  res.send({ token: token.toJwt() });
});

app.listen(3000, () =>
  console.log("✅ Token server running at http://localhost:3000")
);
