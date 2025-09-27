const express = require("express");
const axios = require("axios");
const Redis = require("ioredis"); // Redis kütüphanesini dahil et

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- YENİ: REDIS BAĞLANTISI VE KONTROLÜ ---
// Railway'de Redis servisi kurduğunuzda, bu adres otomatik olarak ortam değişkeni (ENV) olarak atanır.
const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
    console.warn("🚨 Dikkat: REDIS_URL ortam değişkeni tanımlı değil. Yorum kilitleme (tekilleştirme) çalışmayacaktır.");
}

const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

if (redis) {
    redis.on("error", (err) => console.error("🚨 Redis Bağlantı Hatası:", err));
    redis.on("connect", () => console.log("✅ Redis'e başarıyla bağlandı."));
}

// --- Sabitler ---
const VERIFY_TOKEN = "Allah1dir.,";
// SADELEŞTİRİLMİŞ: Yalnızca Pattern isteyen yorumları Telegram'a bildiren otomasyon için Webhook URL'si kaldı.
const PATTERN_REQUEST_WEBHOOK_URL = "https://hook.us2.make.com/rvcgwaursmfmu8gn2mkgxdkvrhyu8yay";

// 1. KRİTİK ÇOK DİLLİ ANAHTAR KELİMELER (Bu kelimeler varsa, yorum filtrelenmez, Make'e gider)
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

// Basit/Alakasız yorumları filtreleyen yardımcı fonksiyon (Önceki mantık korundu)
function isSimpleComment(message) {
    if (!message) return true; 

    const cleanMessage = message.trim().toLowerCase(); 

    // 1. KRİTİK KELİME KONTROLÜ
    for (const keyword of PATTERN_KEYWORDS) {
        if (cleanMessage.includes(keyword)) {
            return false; // Basit DEĞİL, Make'e gitmeli
        }
    }
    
    // 2. AKILLI KISA METİN FİLTRESİ
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
    if (/(.)\1{5,}/.test(cleanMessage)) {
        return true;
    }
    const nonTextContent = cleanMessage.replace(/[a-zA-Z0-9ğüşıöçĞÜŞİÖÇ\s]/g, '');
    if (cleanMessage.length > 0 && nonTextContent.length / cleanMessage.length > 0.9) {
        return true;
    }

    return false; // Hiçbir filtreye takılmadı (Make'e gönder)
}
// --- FİLTRE SABİTLERİ SONU ---

// ✅ Otomasyonun çalışacağı izinli Facebook Sayfa ID'leri
const ALLOWED_PAGE_IDS = new Set([
    "768328876640929",    // Nasıl Yapılır TV
    "757013007687866",    // Hobiler
    "708914999121089",    // Nurgül İle El sanatları
    "141535723466",        // My Hobby
    "1606844446205856",    // El Sanatları ve Hobi
    "300592430012288",     // Knitting &    Crochet World
    "1802019006694158",    // Modelist/Terzi    Hatice DEMİR
    "105749897807346"      // Fashion World
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

        // --- YENİ GÖNDERİ KONTROLÜ (İstenmeyen kısımlar çıkarıldı) ---
        // Sadece yorumları işleyeceğiz. Yeni gönderi tipi tetikleyiciler göz ardı edilir.
        
        // --- YENİ YORUM KONTROLÜ ---
        const isNewComment = item === "comment" && verb === "add";
        if (isNewComment) {
            const fromId = changes.value.from?.id;
            const commentId = changes.value.comment_id; // Yorum ID'sini çek
            const commentMessage = changes.value.message; // Yorum içeriği

            if (!ALLOWED_PAGE_IDS.has(pageId)) {
                console.log(`⛔ Yorum, izinli olmayan bir sayfadan (${pageId}). İşlenmedi.`);
                return res.status(200).send("Sayfa izinli değil.");
            }
            if (fromId && fromId === pageId) {
                console.log(`⛔ Sayfanın kendi yorumu (${pageId}). Döngü önlemi. İşlenmedi.`);
                return res.status(200).send("Sayfanın kendi yorumu.");
            }
            
            // 🚨 REDIS KİLİT KONTROLÜ (Tekrar İşleme Önlemi)
            if (redis && commentId) {
                const redisKey = `comment:${commentId}`;
                
                // Redis'te bu commentId zaten var mı?
                const isProcessed = await redis.get(redisKey);

                if (isProcessed) {
                    console.log(`⛔ Yorum ID Redis'te Kilitli: ${commentId}. Daha önce işlenmiş. İşlenmedi.`);
                    return res.status(200).send("Yorum daha önce işlenmiş (Redis Kilidi).");
                }
            }
            
            // 🚨 FİLTRELEME ADIMI: Basit/Alakasız yorumları Make'e göndermeden durdur
            if (isSimpleComment(commentMessage)) {
                console.log(`⛔ Basit/Kısa Yorum Filtresi. Make'e gönderilmedi: "${commentMessage}"`);
                return res.status(200).send("Yorum, basit filtreye takıldı. Make operasyonu harcanmadı.");
            }
            // Filtreyi geçen ve KİLİTLİ OLMAYAN yorumlar Make'e gönderilir

            console.log(`✅ Yeni kullanıcı yorumu (${pageId}). Pattern Otomasyonuna gönderiliyor. (Filtreyi ve Kilidi geçti)`);
            
            let successful = true;

            // 1. Pattern İstek Otomasyonu Gönderimi (Tek amaçlı webhook)
            try {
                await axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body);
                console.log("✅ PATTERN_REQUEST_WEBHOOK_URL'e gönderim başarılı.");
            } catch (error) {
                successful = false;
                console.error(`🚨 PATTERN_REQUEST_WEBHOOK_URL Hata: ${error.message}. Statu: ${error.response ? error.response.status : 'Bilinmiyor'}`);
            }
            
            // --- BAŞARILI GÖNDERİM SONRASI REDIS'E KİLİT KOYMA ---
            // Yorum, Make'e başarılı şekilde gönderildiyse Redis'e kilitlenir.
            if (successful && redis && commentId) {
                const redisKey = `comment:${commentId}`;
                // Kilit süresi: 30 gün (2592000 saniye)
                await redis.set(redisKey, "1", "EX", 2592000); 
                console.log(`✅ Yorum ID Redis'e kilitlendi: ${commentId}`);
            }

            if (successful) {
                return res.status(200).send("Yorum, Pattern otomasyonuna başarılı şekilde gönderildi.");
            } else {
                // En az bir gönderim başarısız olduysa bile Facebook'a 200 dönüyoruz (Retry'ı önlemek için)
                return res.status(200).send("Yorum gönderimi denendi, Pattern senaryosunda hata oluştu.");
            }
        }

        // Yukarıdaki koşullara uymayan diğer her şey
        console.log(`⛔ Gereksiz tetikleme (${item}, ${verb}). İşlenmedi.`);
        res.status(200).send("Gereksiz tetikleme.");

    } catch (error) {
        console.error("🚨 Webhook işlenemedi (Genel Hata):", error.message);
        res.sendStatus(500);
    }
});

// --- Diğer Endpoint'ler (Değişiklik Yok - Sadece OAuth için gerekli altyapı) ---
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
