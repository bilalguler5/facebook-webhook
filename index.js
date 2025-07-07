const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- Sabitler ---
const VERIFY_TOKEN = "Allah1dir.,";
const COMMENT_WEBHOOK_URL = "https://hook.us2.make.com/jpkfwm4kjvpdjly72jciots7wtevnbx8"; // Mevcut yorum otomasyonu
const NEW_VIDEO_WEBHOOK_URL = "https://hook.us2.make.com/uj2w7lpphvej3lmtudfpmhwnezxxu7om"; // YENİ video otomasyonu

// ✅ Otomasyonun çalışacağı izinli Facebook Sayfa ID'leri
const ALLOWED_PAGE_IDS = new Set([
  "768328876640929",    // Nasıl Yapılır TV
  "757013007687866",    // Hobiler
  "708914999121089",    // Nurgül İle El sanatları
  "141535723466",       // My Hobby
  "1606844446205856",   // El Sanatları ve Hobi
  "300592430012288",    // Knitting &   Crochet World
  "1802019006694158",   // Modelist/Terzi   Hatice DEMİR
  "105749897807346"     // Fashion World
]);

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

// 📩 Facebook → Webhook → İlgili Make Senaryosuna Yönlendirme
app.post("/webhook", async (req, res) => {
  console.log("📨 Facebook'tan veri geldi:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];

    if (!entry || !changes?.value) {
        return res.status(200).send("Veri yapısı eksik, işlenmedi.");
    }
    
    const item = changes.value.item;
    const verb = changes.value.verb;
    const pageId = entry.id;

    // --- ÖNCE YENİ VİDEO GÖNDERİSİ KONTROLÜ ---
    const isNewVideo = (item === 'status' || item === 'video') && verb === 'add' && changes.value.status_type === 'added_video';

    if (isNewVideo) {
      console.log(`✅ Yeni video gönderisi algılandı (${pageId}). Yorum yapmak için senaryo tetikleniyor.`);
      await axios.post(NEW_VIDEO_WEBHOOK_URL, req.body);
      return res.status(200).send("Yeni video gönderisi işlenmek üzere gönderildi.");
    }
    
    // --- SONRA MEVCUT YORUM KONTROLÜ ---
    const isNewComment = item === "comment" && verb === "add";
    if (isNewComment) {
      const fromId = changes.value.from?.id;
      if (!ALLOWED_PAGE_IDS.has(pageId)) {
        console.log(`⛔ Yorum, izinli olmayan bir sayfadan (${pageId}). İşlenmedi.`);
        return res.status(200).send("Sayfa izinli değil.");
      }
      if (fromId && fromId === pageId) {
        console.log(`⛔ Sayfanın kendi yorumu (${pageId}). Döngü önlemi. İşlenmedi.`);
        return res.status(200).send("Sayfanın kendi yorumu.");
      }
      
      console.log(`✅ Yeni kullanıcı yorumu (${pageId}). Yorum otomasyonuna gönderiliyor.`);
      await axios.post(COMMENT_WEBHOOK_URL, req.body);
      return res.status(200).send("Yorum otomasyonuna gönderildi.");
    }

    // Yukarıdaki koşullara uymayan diğer her şey
    console.log(`⛔ Gereksiz tetikleme (${item}, ${verb}). İşlenmedi.`);
    res.status(200).send("Gereksiz tetikleme.");

  } catch (error) {
    console.error("🚨 Webhook işlenemedi:", error.message);
    res.sendStatus(500);
  }
});

// --- Diğer Endpoint'ler (Değişiklik Yok) ---
const APP_ID = "1203840651490478";
const APP_SECRET = "de926e19322760edf3b377e0255469de";
const REDIRECT_URI = "https://facebook-webhook-production-410a.up.railway.app/auth";

app.get("/", (req, res) => {
    // ...
});
app.get("/auth", async (req, res) => {
    // ...
});
app.get("/pages", async (req, res) => {
    // ...
});
app.post("/subscribe", async (req, res) => {
    // ...
});

// 🚀 Server Başlat
app.listen(PORT, () => {
  console.log(`🚀 Server çalışıyor: http://localhost:${PORT}`);
});
