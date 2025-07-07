const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- Sabitler ---
const VERIFY_TOKEN = "Allah1dir.,";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/jpkfwm4kjvpdjly72jciots7wtevnbx8";

// ✅ Otomasyonun çalışacağı izinli Facebook Sayfa ID'leri
const ALLOWED_PAGE_IDS = new Set([
  "768328876640929",    // Nasıl Yapılır TV
  "757013007687866",    // Hobiler
  "708914999121089",    // Nurgül İle El sanatları
  "141535723466",       // My Hobby
  "1606844446205856",   // El Sanatları ve Hobi
  "300592430012288",    // Knitting &   Crochet World
  "1802019006694158"    // Modelist/Terzi   Hatice DEMİR
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

// 📩 Facebook → Webhook → Make.com (Tüm Filtreler Entegre Edilmiş)
app.post("/webhook", async (req, res) => {
  console.log("📨 Facebook'tan veri geldi:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];

    // Gerekli verilerin varlığını kontrol et
    if (!entry || !changes?.value) {
        console.log("⛔ Gelen veri yapısı eksik, işlenmedi.");
        return res.status(200).send("Veri yapısı eksik, işlenmedi.");
    }
    
    const item = changes.value.item;
    const verb = changes.value.verb;
    const fromId = changes?.value?.from?.id; // Yorumu yapanın ID'si
    const pageId = entry.id; // Sayfanın ID'si

    // ✅ Filtre 1: Sadece yeni yapılan yorumlar (comment + add)
    const isNewComment = item === "comment" && verb === "add";
    if (!isNewComment) {
      console.log(`⛔ Gereksiz tetikleme (${item}, ${verb}) – işlenmedi.`);
      return res.status(200).send("Gereksiz tetikleme – işlenmedi");
    }

    // ✅ Filtre 2: Yorumun izin verilen sayfalardan gelip gelmediğini kontrol et
    if (!ALLOWED_PAGE_IDS.has(pageId)) {
      console.log(`⛔ ${pageId} ID'li sayfa izin listesinde değil. Yorum Make'e gönderilmedi.`);
      return res.status(200).send("Sayfa izinli değil, işlenmedi.");
    }
    
    // ✅ YENİ FİLTRE 3: Yorumu yapan sayfanın kendisi mi? (Sonsuz döngü önlemi)
    if (fromId && fromId === pageId) {
      console.log(`⛔ Sayfanın kendi yorumu (${pageId}) – işlenmedi (döngü önlemi).`);
      return res.status(200).send("Sayfanın kendi yorumu, işlenmedi.");
    }

    // ✅ Tüm filtrelerden geçti, yorumu Make'e gönder
    await axios.post(MAKE_WEBHOOK_URL, req.body);
    console.log(`✅ ${pageId} ID'li sayfadan gelen yeni yorum Make'e gönderildi.`);
    res.status(200).send("Make'e gönderildi");

  } catch (error) {
    console.error("🚨 Webhook işlenemedi:", error.message);
    res.sendStatus(500);
  }
});

// --- Diğer Endpoint'ler (Değişiklik Yok) ---
// (Bu kısımlar öncekiyle aynı olduğu için kısaltılmıştır, siz tam halini kullanın)
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
