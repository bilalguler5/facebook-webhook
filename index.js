const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Redis Bağlantısı
let redis = null;

if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL);
    console.log("✅ Redis'e REDIS_URL ile bağlanılıyor...");
} else if (process.env.REDISHOST && process.env.REDISPORT) {
    redis = new Redis({
        host: process.env.REDISHOST,
        port: parseInt(process.env.REDISPORT),
        password: process.env.REDISPASSWORD || undefined,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        reconnectOnError: (err) => err.message.includes("READONLY")
    });
    console.log("✅ Redis'e Host/Port ile bağlanılıyor...");
} else {
    console.error("🚨 HATA: Redis bağlantısı kurulamadı. Duplicate kontrolü çalışmayacak!");
}

// Redis Event Listeners
if (redis) {
    redis.on("error", (err) => console.error(`🚨 Redis Hatası: ${err.message}`));
    redis.on("connect", () => console.log("✅ Redis'e bağlandı!"));
    redis.on("ready", () => console.log("✅ Redis hazır!"));
}

// Sabitler
const VERIFY_TOKEN = "Allah1dir.,";
const PATTERN_REQUEST_WEBHOOK_URL = "https://hook.us2.make.com/rvcgwaursmfmu8gn2mkgxdkvrhyu8yay";

// Pattern Anahtar Kelimeleri
const PATTERN_KEYWORDS = [
    "pattern", "tutorial", "pdf", "template", "description", "guide", "chart", 
    "instructions", "recipe", "how to", "video", "anlatım",
    "patrón", "plantilla", "instrucciones", "receta", "como hacer",
    "padrão", "molde", "instruções", "receita", "como fazer",
    "schema", "modello", "istruzioni", "ricetta", "come fare", "spiegazioni",
    "anleitung", "muster", "schablone", "beschreibung", "wie man",
    "patron", "tutoriel", "modèle", "comment faire"
];

const SHORT_COMMENT_THRESHOLD = 10;
const TURKISH_SIMPLE_PATTERNS = [
    /^(merhaba|teşekkürler|güzel|harika|süper|çok güzel)$/i,
    /^(eline sağlık|ellerine sağlık|çok beğendim)$/i
];

// İzinli Facebook Sayfa ID'leri
const ALLOWED_PAGE_IDS = new Set([
    "768328876640929", "757013007687866", "708914999121089", "141535723466",
    "1606844446205856", "300592430012288", "1802019006694158", "105749897807346"
]);

// Basit Yorum Kontrolü
function isSimpleComment(message) {
    if (!message) return true;
    
    const cleanMessage = message.trim().toLowerCase();
    
    // Pattern kelimelerini kontrol et
    for (const keyword of PATTERN_KEYWORDS) {
        if (cleanMessage.includes(keyword)) {
            console.log(`✅ Pattern kelimesi bulundu: "${keyword}" - İşlenecek`);
            return false;
        }
    }
    
    // Çok kısa yorumları filtrele
    if (cleanMessage.length < SHORT_COMMENT_THRESHOLD) {
        return true;
    }
    
    // Sadece teşekkür/tebrik yorumları
    for (const pattern of TURKISH_SIMPLE_PATTERNS) {
        if (pattern.test(cleanMessage)) {
            return true;
        }
    }
    
    // Spam kontrolü (tekrarlayan karakterler)
    if (/(.)\1{5,}/.test(cleanMessage)) {
        return true;
    }
    
    return false;
}

// Webhook Doğrulama
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook doğrulandı");
        res.status(200).send(challenge);
    } else {
        console.warn("⛔ Webhook doğrulama başarısız");
        res.sendStatus(403);
    }
});

// Ana Webhook Handler
app.post("/webhook", async (req, res) => {
    console.log("📨 Facebook'tan veri geldi");

    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];

        if (!entry || !changes?.value) {
            return res.status(200).send("Eksik veri");
        }

        const item = changes.value.item;
        const verb = changes.value.verb;
        const pageId = entry.id;
        const fromId = changes.value.from?.id;
        const commentId = changes.value.comment_id;
        const commentMessage = changes.value.message;

        // Sadece yeni yorumları işle
        if (item !== "comment" || verb !== "add") {
            return res.status(200).send("Yorum değil");
        }

        // Sayfa kontrolü
        if (!ALLOWED_PAGE_IDS.has(pageId)) {
            console.log(`⛔ İzinsiz sayfa: ${pageId}`);
            return res.status(200).send("İzinsiz sayfa");
        }

        // Sayfanın kendi yorumu mu?
        if (fromId === pageId) {
            console.log("⛔ Sayfanın kendi yorumu");
            return res.status(200).send("Sayfa yorumu");
        }

        // ÖNCE: Redis Duplicate Kontrolü
        if (redis && commentId) {
            try {
                const redisKey = `comment:${commentId}`;
                console.log(`🔍 Redis kontrol: ${redisKey}`);
                
                const isProcessed = await redis.get(redisKey);
                
                if (isProcessed) {
                    console.log(`⛔ DUPLICATE! Yorum zaten işlenmiş: ${commentId}`);
                    return res.status(200).send("Duplicate - Redis'te mevcut");
                }
                
                // Hemen kilitle (race condition önleme)
                await redis.set(redisKey, "processing", "EX", 300);
                console.log(`🔒 Yorum kilitlendi: ${commentId}`);
                
            } catch (redisError) {
                console.error(`🚨 Redis hatası: ${redisError.message}`);
                // Redis hata durumunda devam etme
                return res.status(503).send("Redis hatası");
            }
        } else if (!redis) {
            console.error("🚨 Redis bağlantısı yok!");
            return res.status(503).send("Redis yok");
        }

        // SONRA: Basit yorum filtreleme
        if (isSimpleComment(commentMessage)) {
            console.log(`⛔ Basit yorum filtrelendi: "${commentMessage}"`);
            
            // Redis'ten temizle
            if (redis && commentId) {
                await redis.del(`comment:${commentId}`);
            }
            
            return res.status(200).send("Basit yorum");
        }

        console.log(`✅ Pattern yorumu işleniyor: ${commentId}`);

        // Make.com'a gönder
        try {
            await axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body, {
                timeout: 10000
            });
            console.log("✅ Make.com'a gönderildi");
            
            // Başarılıysa Redis'e kalıcı kaydet
            if (redis && commentId) {
                const redisKey = `comment:${commentId}`;
                await redis.set(redisKey, "completed", "EX", 2592000); // 30 gün
                console.log(`✅ Redis'e kalıcı kaydedildi: ${commentId}`);
            }
            
            return res.status(200).send("Başarılı");
            
        } catch (error) {
            console.error(`🚨 Make.com hatası: ${error.message}`);
            
            // Hata durumunda Redis'ten sil (tekrar denenebilsin)
            if (redis && commentId) {
                await redis.del(`comment:${commentId}`);
            }
            
            return res.status(500).send("Make.com hatası");
        }

    } catch (error) {
        console.error("🚨 Genel hata:", error.message);
        res.sendStatus(500);
    }
});

// Health Check
app.get("/health", async (req, res) => {
    try {
        let redisStatus = false;
        let testResult = null;
        
        if (redis) {
            // Redis'i test et
            const testKey = `test:${Date.now()}`;
            await redis.set(testKey, "test", "EX", 10);
            const value = await redis.get(testKey);
            redisStatus = value === "test";
            testResult = { wrote: "test", read: value };
            await redis.del(testKey);
        }
        
        res.json({
            status: "OK",
            redis: redisStatus,
            redisTest: testResult,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({
            status: "ERROR",
            redis: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// OAuth Endpoints
const APP_ID = "1203840651490478";
const APP_SECRET = "de926e19322760edf3b377e0255469de";
const REDIRECT_URI = "https://facebook-webhook-production-410a.up.railway.app/auth";

app.get("/", (req, res) => {
    const oauthLink = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&scope=pages_manage_metadata,pages_read_engagement,pages_show_list&response_type=code`;
    res.send(`
        <html>
        <head><title>Facebook Webhook</title></head>
        <body>
            <h1>Facebook Webhook Sistemi</h1>
            <p>Redis Durumu: ${redis ? "Bağlı" : "Bağlı Değil"}</p>
            <a href="${oauthLink}">👉 Facebook Sayfa Yetkisi Ver</a>
            <br><br>
            <a href="/health">📊 Sistem Durumu</a>
        </body>
        </html>
    `);
});

app.get("/auth", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Authorization kodu yok");
    
    try {
        const result = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
            params: {
                client_id: APP_ID,
                client_secret: APP_SECRET,
                redirect_uri: REDIRECT_URI,
                code
            }
        });
        console.log("✅ Access Token:", result.data.access_token);
        res.send("✅ Token alındı! Console'u kontrol edin.");
    } catch (err) {
        console.error("Token hatası:", err.message);
        res.send("Token alınamadı");
    }
});

// Server Başlat
app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda başladı`);
    console.log(`📦 Redis durumu: ${redis ? "Bağlı" : "BAĞLI DEĞİL"}`);
});
