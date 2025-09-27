const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- YENİ: REDIS BAĞLANTISI VE KONTROLÜ (HOST/PORT KULLANAN SAĞLAM YÖNTEM) ---
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD; // Şifre varsa kullanılır

if (!REDIS_HOST || !REDIS_PORT) {
    console.warn("🚨 Dikkat: REDIS_HOST veya REDIS_PORT ortam değişkeni tanımlı değil. Yorum kilitleme (tekilleştirme) çalışmayacaktır.");
    var redis = null;
} else {
    // Redis kütüphanesini Host, Port ve Password ile yapılandır
    var redis = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASSWORD // Şifre tanımlıysa kullanılır
    });

    redis.on("error", (err) => {
        // Hata logu sadece Host/Port üzerinden bağlantı denendiğinde çalışır.
        // Hatanın sürekli tekrarlamaması için, bu log Redis bağlantı hatasını yakalar.
        console.error(`🚨 Redis Bağlantı Hatası: Sunucuya ulaşılamıyor (Host/Port ile denendi): ${err.message}`);
    });
    redis.on("connect", () => console.log("✅ Redis'e başarıyla bağlandı. (Host/Port yöntemi)"));
}

// --- Sabitler ---
const VERIFY_TOKEN = "Allah1dir.,";
const PATTERN_REQUEST_WEBHOOK_URL = "https://hook.us2.make.com/rvcgwaursmfmu8gn2mkgxdkvrhyu8yay";

// KRİTİK ÇOK DİLLİ ANAHTAR KELİMELER (Filtre mantığı korundu)
const PATTERN_KEYWORDS = [
    "pattern", "tutorial", "pdf", "template", "description", "guide", "chart", "instructions", "recipe", "how to",
    "patrón", "tutorial", "plantilla", "instrucciones", "receta", "como hacer",
    "padrão", "tutorial", "molde", "instruções", "receita", "como fazer",
    "schema", "tutorial", "modello", "istruzioni", "ricetta", "come fare", "spiegazioni",
    "anleitung", "muster", "tutorial", "schablone", "beschreibung", "wie man",
    "patron", "tutoriel", "modèle", "instructions", "recette", "comment faire"
];

const SHORT_COMMENT_THRESHOLD = 10;
const TURKISH_REJECT_PATTERNS = [
    /\b(merhaba|teşekkürler|güzel|harika|süper|bye bye|çok güzel)\b/i, 
    /\b(ellerine sağlık|eline sağlık|çok beğendim|iyi günler|iyi çalışmalar)\b/i,
];

function isSimpleComment(message) {
    if (!message) return true; 
    const cleanMessage = message.trim().toLowerCase(); 

    for (const keyword of PATTERN_KEYWORDS) {
        if (cleanMessage.includes(keyword)) return false;
    }
    if (cleanMessage.length < SHORT_COMMENT_THRESHOLD) return true;
    for (const pattern of TURKISH_REJECT_PATTERNS) {
        if (pattern.test(cleanMessage)) return true;
    }
    if (/(.)\1{5,}/.test(cleanMessage)) return true;
    const nonTextContent = cleanMessage.replace(/[a-zA-Z0-9ğüşıöçĞÜŞİÖÇ\s]/g, '');
    if (cleanMessage.length > 0 && nonTextContent.length / cleanMessage.length > 0.9) return true;

    return false;
}
// --- FİLTRE SABİTLERİ SONU ---

// ✅ Otomasyonun çalışacağı izinli Facebook Sayfa ID'leri
const ALLOWED_PAGE_IDS = new Set([
    "768328876640929", "757013007687866", "708914999121089", "141535723466",
    "1606844446205856", "300592430012288", "1802019006694158", "105749897807346"
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

        if (!entry || !changes?.value) return res.status(200).send("Veri yapısı eksik, işlenmedi.");

        const item = changes.value.item;
        const verb = changes.value.verb;
        const pageId = entry.id;
        const isNewComment = item === "comment" && verb === "add";

        if (isNewComment) {
            const fromId = changes.value.from?.id;
            const commentId = changes.value.comment_id;
            const commentMessage = changes.value.message;

            if (!ALLOWED_PAGE_IDS.has(pageId)) {
                return res.status(200).send("Sayfa izinli değil.");
            }
            if (fromId && fromId === pageId) {
                return res.status(200).send("Sayfanın kendi yorumu.");
            }
            
            // 🚨 REDIS KİLİT KONTROLÜ (Tekrar İşleme Önlemi)
            if (redis && commentId) {
                const redisKey = `comment:${commentId}`;
                const isProcessed = await redis.get(redisKey);

                if (isProcessed) {
                    console.log(`⛔ Yorum ID Redis'te Kilitli: ${commentId}. Daha önce işlenmiş. İşlenmedi.`);
                    return res.status(200).send("Yorum daha önce işlenmiş (Redis Kilidi).");
                }
            }
            
            // 🚨 FİLTRELEME ADIMI
            if (isSimpleComment(commentMessage)) {
                console.log(`⛔ Basit/Kısa Yorum Filtresi. Make'e gönderilmedi: "${commentMessage}"`);
                return res.status(200).send("Yorum, basit filtreye takıldı. Make operasyonu harcanmadı.");
            }

            console.log(`✅ Yeni kullanıcı yorumu (${pageId}). Pattern Otomasyonuna gönderiliyor. (Filtreyi ve Kilidi geçti)`);
            
            let successful = true;

            // Pattern İstek Otomasyonu Gönderimi
            try {
                await axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body);
                console.log("✅ PATTERN_REQUEST_WEBHOOK_URL'e gönderim başarılı.");
            } catch (error) {
                successful = false;
                console.error(`🚨 PATTERN_REQUEST_WEBHOOK_URL Hata: ${error.message}. Statu: ${error.response ? error.response.status : 'Bilinmiyor'}`);
            }
            
            // --- BAŞARILI GÖNDERİM SONRASI REDIS'E KİLİT KOYMA ---
            if (successful && redis && commentId) {
                const redisKey = `comment:${commentId}`;
                // Kilit süresi: 30 gün (2592000 saniye)
                await redis.set(redisKey, "1", "EX", 2592000); 
                console.log(`✅ Yorum ID Redis'e kilitlendi: ${commentId}`);
            }

            if (successful) {
                return res.status(200).send("Yorum, Pattern otomasyonuna başarılı şekilde gönderildi.");
            } else {
                return res.status(200).send("Yorum gönderimi denendi, Pattern senaryosunda hata oluştu.");
            }
        }

        console.log(`⛔ Gereksiz tetikleme (${item}, ${verb}). İşlenmedi.`);
        res.status(200).send("Gereksiz tetikleme.");

    } catch (error) {
        console.error("🚨 Webhook işlenemedi (Genel Hata):", error.message);
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
