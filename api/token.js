// /api/token.js — Génération de token Twilio Voice pour client navigateur
import { jwt } from "twilio";

export default async function handler(req, res) {
  const { AccessToken } = jwt;
  const { VoiceGrant } = AccessToken;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;
  const appSid = process.env.TWIML_APP_SID;

  if (!accountSid || !apiKey || !apiSecret || !appSid) {
    return res.status(500).json({ error: "Missing Twilio credentials" });
  }

  const identity = "browser_tester";

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: appSid,
    incomingAllow: true,
  });

  const token = new AccessToken(accountSid, apiKey, apiSecret, { identity });
  token.addGrant(voiceGrant);

  res.status(200).json({ token: token.toJwt() });
}
