const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- DÜZELTİLMİŞ REDIS BAĞLANTISI ---
// Önce REDIS_URL'yi kontrol et, yoksa parçalı bağlantıyı kullan
let redis = null;

if (process.env.REDIS_URL) {
    // Railway'in sağladığı tam URL'yi kullan
    redis = new Redis(process.env.REDIS_URL);
    console.log("✅ Redis'e REDIS_URL ile bağlanılıyor...");
} else if (process.env.REDISHOST && process.env.REDISPORT) {
    // Alternatif: Host, Port ve Password ile bağlan
    redis = new Redis({
        host: process.env.REDISHOST,
        port: parseInt(process.env.REDISPORT),
        password: process.env.REDISPASSWORD || undefined,
        // Ek güvenlik ayarları
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
        reconnectOnError: (err) => {
            const targetError = "READONLY";
            if (err.message.includes(targetError)) {
                return true;
            }
            return false;
        }
    });
    console.log("✅ Redis'e Host/Port ile bağlanılıyor...");
} else {
    console.warn("🚨 Dikkat: Redis ortam değişkenleri tanımlı değil. Yorum kilitleme çalışmayacaktır.");
}

// Redis event listener'ları
if (redis) {
    redis.on("error", (err) => {
        console.error(`🚨 Redis Bağlantı Hatası: ${err.message}`);
    });
    
    redis.on("connect", () => {
        console.log("✅ Redis'e başarıyla bağlandı!");
    });
    
    redis.on("ready", () => {
        console.log("✅ Redis kullanıma hazır!");
    });
}

// --- Sabitler ---
const VERIFY_TOKEN = "Allah1dir.,";
const PATTERN_REQUEST_WEBHOOK_URL = "https://hook.us2.make.com/rvcgwaursmfmu8gn2mkgxdkvrhyu8yay";

// KRİTİK ÇOK DİLLİ ANAHTAR KELİMELER
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

// ✅ İzinli Facebook Sayfa ID'leri
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

// 📩 Facebook Webhook İşleyici
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
            
            // 🚨 REDIS KİLİT KONTROLÜ
            if (redis && commentId) {
                try {
                    const redisKey = `comment:${commentId}`;
                    const isProcessed = await redis.get(redisKey);

                    if (isProcessed) {
                        console.log(`⛔ Yorum zaten işlenmiş (Redis): ${commentId}`);
                        return res.status(200).send("Yorum daha önce işlenmiş.");
                    }
                } catch (redisError) {
                    console.error(`Redis okuma hatası: ${redisError.message}`);
                    // Redis hatası durumunda işleme devam et
                }
            }
            
            // 🚨 FİLTRELEME
            if (isSimpleComment(commentMessage)) {
                console.log(`⛔ Basit yorum filtrelendi: "${commentMessage}"`);
                return res.status(200).send("Basit yorum, işlenmedi.");
            }

            console.log(`✅ Yeni yorum işleniyor: ${commentId}`);
            
            let successful = true;

            // Make.com'a gönder
            try {
                await axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body);
                console.log("✅ Make.com'a başarıyla gönderildi.");
            } catch (error) {
                successful = false;
                console.error(`🚨 Make.com gönderim hatası: ${error.message}`);
            }
            
            // Başarılıysa Redis'e kaydet
            if (successful && redis && commentId) {
                try {
                    const redisKey = `comment:${commentId}`;
                    // 30 gün boyunca sakla
                    await redis.set(redisKey, "1", "EX", 2592000);
                    console.log(`✅ Yorum Redis'e kaydedildi: ${commentId}`);
                } catch (redisError) {
                    console.error(`Redis yazma hatası: ${redisError.message}`);
                }
            }

            return res.status(200).send(successful ? 
                "Yorum başarıyla işlendi." : 
                "Yorum işlenemedi."
            );
        }

        console.log(`⛔ Farklı tetikleme: ${item}, ${verb}`);
        res.status(200).send("Diğer olay tipi.");

    } catch (error) {
        console.error("🚨 Webhook işleme hatası:", error.message);
        res.sendStatus(500);
    }
});

// --- OAuth Endpoint'leri ---
const APP_ID = "1203840651490478";
const APP_SECRET = "de926e19322760edf3b377e0255469de";
const REDIRECT_URI = "https://facebook-webhook-production-410a.up.railway.app/auth";

app.get("/", (req, res) => {
    const oauthLink = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&scope=pages_manage_metadata,pages_read_engagement,pages_show_list&response_type=code`;
    res.send(`
        <html>
        <head><title>Facebook OAuth</title></head>
        <body>
            <h1>Facebook OAuth</h1>
            <a href="${oauthLink}" target="_blank">👉 Facebook Sayfa Yetkisi Ver</a>
        </body>
        </html>
    `);
});

app.get("/auth", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("❌ Authorization kodu alınamadı.");
    
    try {
        const result = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
            params: {
                client_id: APP_ID,
                client_secret: APP_SECRET,
                redirect_uri: REDIRECT_URI,
                code
            }
        });
        console.log("✅ Access Token alındı:", result.data.access_token);
        res.send("✅ Access Token alındı! Loglara bakın.");
    } catch (err) {
        console.error("🚨 Access Token hatası:", err.message);
        res.send("❌ Token alınamadı.");
    }
});

app.get("/pages", async (req, res) => {
    const accessToken = req.query.token;
    try {
        const response = await axios.get(`https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}`);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Sayfa listesi hatası:", error.message);
        res.status(500).send("❌ Sayfa listesi alınamadı.");
    }
});

app.post("/subscribe", async (req, res) => {
    const { pageId, pageAccessToken } = req.body;
    try {
        await axios.post(`https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`, {}, {
            headers: { Authorization: `Bearer ${pageAccessToken}` }
        });
        res.send("✅ Webhook abone olundu.");
    } catch (error) {
        console.error("🚨 Abonelik hatası:", error.message);
        res.status(500).send("❌ Webhook aboneliği başarısız.");
    }
});

// Health check endpoint
app.get("/health", async (req, res) => {
    const health = {
        status: "OK",
        redis: redis ? await redis.ping() === "PONG" : false,
        timestamp: new Date().toISOString()
    };
    res.json(health);
});

// 🚀 Server'ı başlat
app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda çalışıyor`);
    if (redis) {
        console.log("📦 Redis bağlantısı kontrol ediliyor...");
    } else {
        console.log("⚠️ Redis bağlantısı yok - yorum kilitleme devre dışı!");
    }
});
