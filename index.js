const express = require("express");
const axios = require("axios"); // Make'e veri göndermek için

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
// Facebook OAuth için basit anasayfa
app.get('/', (req, res) => {
  res.send('Facebook OAuth için buradayız');
});

// Facebook'tan gelen veriyi Make'e gönder
app.post("/webhook", async (req, res) => {
  console.log("📨 Facebook'tan veri geldi:", JSON.stringify(req.body, null, 2));

  try {
    await axios.post(
      "https://hook.us2.make.com/jpkfwm4kjvpdjly72jciots7wtevnbx8",
      req.body,
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
