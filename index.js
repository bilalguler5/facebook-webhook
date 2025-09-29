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
    console.error("🚨 HATA: Redis bağlantısı kurulamadı!");
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
    "instructions", "recipe", "how to", "video", "anlatım", "tarif",
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
    if (!message || message === "undefined" || message === "null") return true;
    
    const cleanMessage = message.trim().toLowerCase();
    
    // Pattern kelimelerini kontrol et
    for (const keyword of PATTERN_KEYWORDS) {
        if (cleanMessage.includes(keyword)) {
            console.log(`✅ Pattern kelimesi bulundu: "${keyword}"`);
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
    
    // Spam kontrolü
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

        // Comment ID yoksa işleme
        if (!commentId) {
            console.log("⛔ Comment ID yok");
            return res.status(200).send("Comment ID yok");
        }

        // ÖNCE: Redis Duplicate Kontrolü
        if (redis) {
            try {
                const redisKey = `comment:${commentId}`;
                console.log(`🔍 Redis kontrol: ${redisKey}`);
                
                // Önce kontrol et
                const existingValue = await redis.get(redisKey);
                
                if (existingValue) {
                    console.log(`⛔ DUPLICATE BULUNDU! ${commentId}`);
                    console.log(`📊 Mevcut değer: ${existingValue}`);
                    return res.status(200).send("Duplicate");
                }
                
                // Yoksa hemen 30 günlük kaydet
                await redis.set(redisKey, "1", "EX", 2592000);
                console.log(`✅ Redis'e yeni kayıt: ${commentId} (30 gün)`);
                
            } catch (redisError) {
                console.error(`🚨 Redis hatası: ${redisError.message}`);
                return res.status(503).send("Redis hatası");
            }
        } else {
            console.error("🚨 Redis bağlantısı yok!");
            return res.status(503).send("Redis yok");
        }

        // Mesaj kontrolü
        if (!commentMessage || commentMessage === "undefined") {
            console.log("⛔ Mesaj içeriği yok");
            // Redis'ten sil
            if (redis) {
                await redis.del(`comment:${commentId}`);
            }
            return res.status(200).send("Mesaj yok");
        }

        // SONRA: Basit yorum filtreleme
        if (isSimpleComment(commentMessage)) {
            console.log(`⛔ Basit yorum: "${commentMessage.substring(0, 50)}..."`);
            // Redis'ten sil
            if (redis) {
                await redis.del(`comment:${commentId}`);
                console.log(`🗑️ Redis'ten silindi: ${commentId}`);
            }
            return res.status(200).send("Basit yorum");
        }

        console.log(`✅ Pattern yorumu, Make.com'a gönderiliyor: ${commentId}`);

        // Make.com'a gönder
        try {
            await axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body, {
                timeout: 10000
            });
            console.log("✅ Make.com'a başarıyla gönderildi");
            return res.status(200).send("Başarılı");
            
        } catch (error) {
            console.error(`🚨 Make.com hatası: ${error.message}`);
            // Hata durumunda Redis'ten sil (tekrar denenebilsin)
            if (redis) {
                await redis.del(`comment:${commentId}`);
                console.log(`🗑️ Make.com hatası, Redis'ten silindi: ${commentId}`);
            }
            return res.status(500).send("Make.com hatası");
        }

    } catch (error) {
        console.error("🚨 Genel hata:", error);
        res.sendStatus(500);
    }
});

// Health Check
app.get("/health", async (req, res) => {
    try {
        let redisStatus = false;
        let redisKeyCount = 0;
        let testResult = null;
        
        if (redis) {
            // Test key
            const testKey = `health:${Date.now()}`;
            await redis.set(testKey, "test", "EX", 10);
            const value = await redis.get(testKey);
            redisStatus = value === "test";
            await redis.del(testKey);
            
            // Key sayısını al
            const keys = await redis.keys("comment:*");
            redisKeyCount = keys.length;
            
            testResult = { 
                status: redisStatus ? "OK" : "ERROR",
                totalComments: redisKeyCount 
            };
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
        <body style="font-family: Arial; padding: 20px;">
            <h1>Facebook Webhook Sistemi</h1>
            <p><strong>Redis:</strong> ${redis ? "✅ Bağlı" : "❌ Bağlı Değil"}</p>
            <p><a href="${oauthLink}">👉 Facebook Sayfa Yetkisi Ver</a></p>
            <p><a href="/health">📊 Sistem Durumu</a></p>
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
    console.log(`📦 Redis: ${redis ? "✅ Bağlı" : "❌ BAĞLI DEĞİL"}`);
    if (!redis) {
        console.error("⚠️ DİKKAT: Redis olmadan duplicate kontrolü çalışmaz!");
    }
});
