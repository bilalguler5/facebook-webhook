const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const VERIFY_TOKEN = "Allah1dir.,";

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

// Facebook OAuth basit arayüz
app.get("/", (req, res) => {
  const oauthLink = `https://www.facebook.com/v19.0/dialog/oauth?client_id=1203840651490478&redirect_uri=https://facebook-webhook-production-410a.up.railway.app/&scope=pages_manage_metadata,pages_read_engagement,pages_show_list&response_type=token`;

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

// Webhook POST (Make'e gönder)
app.post("/webhook", async (req, res) => {
  console.log("📨 Facebook'tan veri geldi:", JSON.stringify(req.body, null, 2));

  try {
    await axios.post(
      "https://hook.us2.make.com/jpkfwm4kjvpdjly72jciots7wtevnbx8",
      req.body
    );
    console.log("✅ Veri Make'e gönderildi.");
  } catch (error) {
    console.error("🚨 HATA:", error.message);
  }

  res.sendStatus(200);
});

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`🚀 Server aktif: http://localhost:${PORT}`);
});
