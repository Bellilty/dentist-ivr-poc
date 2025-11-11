// Inside server.js
import "dotenv/config";
import express from "express";
import pkg from "twilio";

const app = express();
const { jwt } = pkg;
const { AccessToken } = jwt;
const { VoiceGrant } = AccessToken;

app.get("/api/token", (req, res) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKey = process.env.TWILIO_API_KEY;
    const apiSecret = process.env.TWILIO_API_SECRET;
    const appSid = process.env.TWIML_APP_SID;

    if (!accountSid || !apiKey || !apiSecret || !appSid) {
      console.error("❌ Missing Twilio credentials in environment");
      return res.status(500).json({ error: "Missing Twilio credentials" });
    }

    const identity = "browser_tester";
    const voiceGrant = new VoiceGrant({ outgoingApplicationSid: appSid });

    const token = new AccessToken(accountSid, apiKey, apiSecret, { identity });
    token.addGrant(voiceGrant);

    const jwtToken = token.toJwt();
    console.log("✅ Token generated for:", identity);

    res.status(200).json({ token: jwtToken });
  } catch (err) {
    console.error("🔥 Token generation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static("public"));
app.use("/public", express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
