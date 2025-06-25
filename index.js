const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 🔐 Gerekli Kimlik Bilgileri
const VERIFY_TOKEN = "Allah1dir.,";
const APP_ID = "1203840651490478";
const APP_SECRET = "de926e19322760edf3b377e0255469de";
const REDIRECT_URI = "https://facebook-webhook-production-410a.up.railway.app/auth";

// ✅ Webhook Doğrulama
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

// 🌐 OAuth Başlatıcı Link
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

// 🔑 Token Alma Endpointi (Facebook → /auth → Token)
app.get("/auth", async (req, res) => {
  const code = req.query.code;

  if (!code) return res.send("❌ Authorization kodu alınamadı.");

  try {
    const result = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
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

// 📩 Facebook → Webhook → Make.com
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

// 📄 Facebook Sayfalarını Listele
app.get("/pages", async (req, res) => {
  const accessToken = req.query.token;

  try {
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`
    );

    res.json(response.data);
  } catch (error) {
    console.error("🚨 Sayfa listesi alınamadı:", error.message);
    res.status(500).send("❌ Sayfa listesi getirilemedi.");
  }
});

// 🔔 Webhook Aboneliğini Aktif Et
app.post("/subscribe", async (req, res) => {
  const { pageId, pageAccessToken } = req.body;

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
      {},
      {
        headers: {
          Authorization: `Bearer ${pageAccessToken}`,
        },
      }
    );

    res.send("✅ Webhook başarılı şekilde abone oldu.");
  } catch (error) {
    console.error("🚨 Abonelik hatası:", error.message);
    res.status(500).send("❌ Webhook aboneliği başarısız.");
  }
});

// 🚀 Server Başlat
app.listen(PORT, () => {
  console.log(`🚀 Server çalışıyor: http://localhost:${PORT}`);
});
