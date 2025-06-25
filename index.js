const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const VERIFY_TOKEN = "Allah1dir.,";

// 🔐 Bunları sen kendin Dashboard'dan alacaksın:
const APP_ID = "1203840651490478";
const APP_SECRET = "de926e19322760edf3b377e0255469de"; // 👈 Bunu birazdan göstereceğim
const REDIRECT_URI = "https://facebook-webhook-production-410a.up.railway.app/auth";

// Webhook doğrulama
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook doğrulandı.");
    res.status(200).send(challenge);
  } else {
    console.warn("⛔ Webhook doğrulama başarısız.");
    res.sendStatus(403);
  }
});

// Facebook OAuth linki
app.get("/", (req, res) => {
  const oauthLink = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&scope=pages_manage_metadata,pages_read_engagement,pages_show_list&response_type=code`;

  res.send(`
    <html>
      <head><title>Facebook OAuth</title></head>
      <body>
        <h1>Facebook OAuth için buradayız</h1>
        <a href="${oauthLink}" target="_blank">👉 Facebook Sayfa Yetkisi Ver</a>
      </body>
    </html>
  `);
});

// Facebook'tan gelen code ile access_token alma
app.get("/auth", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("❌ Authorization kodu alınamadı.");

  try {
    const result = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code: code,
      },
    });

    const accessToken = result.data.access_token;
    console.log("✅ Facebook Access Token:", accessToken);
    res.send("✅ Access Token alındı! Loglara bakabilirsin.");
  } catch (err) {
    console.error("🚨 Access Token alma hatası:", err.message);
    res.send("❌ Token alma işlemi başarısız.");
  }
});

// Webhook POST (Facebook -> Make.com)
app.post("/webhook", async (req, res) => {
  console.log("📨 Facebook'tan veri geldi:", JSON.stringify(req.body, null, 2));

  try {
    await axios.post(
      "https://hook.us2.make.com/jpkfwm4kjvpdjly72jciots7wtevnbx8",
      req.body
    );
    console.log("✅ Veri Make'e gönderildi.");
  } catch (error) {
    console.error("🚨 Make.com gönderim hatası:", error.message);
  }

  res.sendStatus(200);
});

// Server başlat
app.listen(PORT, () => {
  console.log(`🚀 Server çalışıyor: http://localhost:${PORT}`);
});
