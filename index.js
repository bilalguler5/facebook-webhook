const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- Sabitler ---
const VERIFY_TOKEN = "Allah1dir.,";
// Yorum otomasyonu için Make.com Webhook URL'si
const COMMENT_WEBHOOK_URL = "https://hook.us2.make.com/jpkfwm4kjvpdjly72jciots7wtevnbx8";
// Yeni gönderi (video/resim) otomasyonu için Make.com Webhook URL'si
const NEW_POST_WEBHOOK_URL = "https://hook.us2.make.com/uj2w7lpphvej3lmtudfpmhwnezxxu7om";
// YENİ: Pattern isteyen yorumları Telegram'a bildiren otomasyon için Webhook URL'si
const PATTERN_REQUEST_WEBHOOK_URL = "https://hook.us2.make.com/rvcgwaursmfmu8gn2mkgxdkvrhyu8yay";

// --- YENİ FİLTRE SABİTLERİ (Make Operasyonunu Azaltmak İçin) ---
// 1. KRİTİK ANAHTAR KELİMELER (Bu kelimeler varsa, yorum KISA olsa bile filtrelenmez, Make'e gider)
const PATTERN_KEYWORDS = [
    // İngilizce
    "pattern", "tutorial", "pdf", "template", "description", 
    "guide", "chart", "instructions", "recipe", "how to",
    // İspanyolca
    "patrón", "tutorial", "plantilla", "instrucciones", "receta", "como hacer",
    // Portekizce
    "padrão", "tutorial", "molde", "instruções", "receita", "como fazer",
    // İtalyanca
    "schema", "tutorial", "modello", "istruzioni", "ricetta", "come fare", "spiegazioni",
    // Almanca
    "anleitung", "muster", "tutorial", "schablone", "beschreibung", "wie man",
    // Fransızca
    "patron", "tutoriel", "modèle", "instructions", "recette", "comment faire"
];

// 2. KISA YORUM EŞİĞİ (Anahtar kelime YOKSA, bu karakterden kısa yorumlar filtrelenir)
const SHORT_COMMENT_THRESHOLD = 10; 

// 3. TÜRKÇE ODAKLI BASİT İFADELER (Bu kelimeleri içeren yorumlar, uzunluğuna bakılmaksızın filtrelenir)
const TURKISH_REJECT_PATTERNS = [
    /\b(merhaba|teşekkürler|güzel|harika|süper|bye bye|çok güzel)\b/i, 
    /\b(ellerine sağlık|eline sağlık|çok beğendim|iyi günler|iyi çalışmalar)\b/i,
];

// Basit/Alakasız yorumları filtreleyen yardımcı fonksiyon
function isSimpleComment(message) {
    if (!message) return true; 

    const cleanMessage = message.trim().toLowerCase(); // Kontrol için küçük harfe çevir ve boşlukları temizle

    // 1. KRİTİK KELİME KONTROLÜ (Çok Dilli)
    // Yorumun içinde Pattern isteyen anahtar kelimelerden biri varsa, kısa bile olsa Make'e gönder.
    for (const keyword of PATTERN_KEYWORDS) {
        if (cleanMessage.includes(keyword)) {
            return false; // Basit DEĞİL, Make'e gitmeli
        }
    }
    
    // 2. AKILLI KISA METİN FİLTRESİ
    // Anahtar kelime YOK ve yorum kısa ise (10 karakterden az), filtrele.
    if (cleanMessage.length < SHORT_COMMENT_THRESHOLD) {
        return true; // Basit, Railway'de durdur
    }

    // 3. TÜRKÇE BASİT İFADE FİLTRESİ
    for (const pattern of TURKISH_REJECT_PATTERNS) {
        if (pattern.test(cleanMessage)) {
            return true;
        }
    }
    
    // 4. TEKRARLAYAN KARAKTER/EMOJİ YOĞUNLUĞU FİLTRESİ
    // Çok fazla ardışık tekrar eden harf veya noktalama (örn: !!!!!!!!, wowwwwww)
    if (/(.)\1{5,}/.test(cleanMessage)) {
        return true;
    }
    // Mesajın büyük çoğunluğu (%90'dan fazlası) metin dışı (sadece emoji/noktalama) ise filtrele.
    const nonTextContent = cleanMessage.replace(/[a-zA-Z0-9ğüşıöçĞÜŞİÖÇ\s]/g, '');
    if (cleanMessage.length > 0 && nonTextContent.length / cleanMessage.length > 0.9) {
        return true;
    }

    return false; // Hiçbir filtreye takılmadı (Make'e gönder)
}
// --- FİLTRE SABİTLERİ SONU ---

// ✅ Otomasyonun çalışacağı izinli Facebook Sayfa ID'leri
const ALLOWED_PAGE_IDS = new Set([
  "768328876640929",    // Nasıl Yapılır TV
  "757013007687866",    // Hobiler
  "708914999121089",    // Nurgül İle El sanatları
  "141535723466",       // My Hobby
  "1606844446205856",   // El Sanatları ve Hobi
  "300592430012288",    // Knitting &   Crochet World
  "1802019006694158",   // Modelist/Terzi   Hatice DEMİR
  "105749897807346"     // Fashion World
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

// 📩 Facebook → Webhook → İlgili Make Senaryolarına Yönlendirme
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

    // --- YENİ GÖNDERİ KONTROLÜ (VİDEO, RESİM, DURUM) ---
    const isNewPost = (item === 'status' || item === 'video' || item === 'photo') && verb === 'add';

    if (isNewPost) {
      console.log(`✅ Yeni gönderi (${item}) algılandı (${pageId}). Yorum yapmak için senaryo tetikleniyor.`);
      await axios.post(NEW_POST_WEBHOOK_URL, req.body);
      return res.status(200).send("Yeni gönderi işlenmek üzere gönderildi.");
    }

    // --- YENİ YORUM KONTROLÜ ---
    const isNewComment = item === "comment" && verb === "add";
    if (isNewComment) {
      const fromId = changes.value.from?.id;
      const commentMessage = changes.value.message; // Yorum içeriği

      if (!ALLOWED_PAGE_IDS.has(pageId)) {
        console.log(`⛔ Yorum, izinli olmayan bir sayfadan (${pageId}). İşlenmedi.`);
        return res.status(200).send("Sayfa izinli değil.");
      }
      if (fromId && fromId === pageId) {
        console.log(`⛔ Sayfanın kendi yorumu (${pageId}). Döngü önlemi. İşlenmedi.`);
        return res.status(200).send("Sayfanın kendi yorumu.");
      }
      
      // 🚨 YENİ FİLTRELEME ADIMI: Basit/Alakasız yorumları Make'e göndermeden durdur
      if (isSimpleComment(commentMessage)) {
          console.log(`⛔ Basit/Kısa Yorum Filtresi. Make'e gönderilmedi: "${commentMessage}"`);
          return res.status(200).send("Yorum, basit filtreye takıldı. Make operasyonu harcanmadı.");
      }
      // Filtreyi geçen yorumlar Make'e gönderilir (ve operasyon harcanır)

      console.log(`✅ Yeni kullanıcı yorumu (${pageId}). İlgili otomasyonlara gönderiliyor. (Filtreyi geçti)`);
      
      // Yorumu aynı anda her iki otomasyona da gönder
      await Promise.all([
          axios.post(COMMENT_WEBHOOK_URL, req.body),
          axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body)
      ]);
      
      return res.status(200).send("Yorum, ilgili tüm otomasyonlara gönderildi.");
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
    const oauthLink = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&scope=pages_manage_metadata,pages_read_engagement,pages_show_list&response_type=code`;
    res.send(`<html><head><title>Facebook OAuth</title></head><body><h1>Facebook OAuth için buradayız</h1><a href="${oauthLink}" target="_blank">👉 Facebook Sayfa Yetkisi Ver</a></body></html>`);
});

app.get("/auth", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("❌ Authorization kodu alınamadı.");
    try {
        const result = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", { params: { client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: REDIRECT_URI, code } });
        console.log("✅ Facebook Access Token:", result.data.access_token);
        res.send("✅ Access Token alındı! Loglara bakabilirsin.");
    } catch (err) {
        console.error("🚨 Access Token alma hatası:", err.message);
        res.send("❌ Token alma işlemi başarısız.");
    }
});

app.get("/pages", async (req, res) => {
    const accessToken = req.query.token;
    try {
        const response = await axios.get(`https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Sayfa listesi alınamadı:", error.message);
        res.status(500).send("❌ Sayfa listesi getirilemedi.");
    }
});

app.post("/subscribe", async (req, res) => {
    const { pageId, pageAccessToken } = req.body;
    try {
        await axios.post(`https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`, {}, { headers: { Authorization: `Bearer ${pageAccessToken}` } });
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
