const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Redis Bağlantısı
let redis = null;

if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
        retryStrategy: (times) => Math.min(times * 50, 2000)
    });
    console.log("✅ Redis'e bağlanılıyor...");
} else {
    console.error("🚨 Redis bağlantısı kurulamadı!");
}

if (redis) {
    redis.on("error", (err) => console.error(`🚨 Redis Hatası: ${err.message}`));
    redis.on("connect", () => console.log("✅ Redis'e bağlandı!"));
    redis.on("ready", () => console.log("✅ Redis hazır!"));
}

const VERIFY_TOKEN = "Allah1dir.,";
const PATTERN_REQUEST_WEBHOOK_URL = "https://hook.us2.make.com/rvcgwaursmfmu8gn2mkgxdkvrhyu8yay";

// GÜNCELLENMİŞ Pattern Kelimeleri - Çok dilli
const PATTERN_KEYWORDS = [
    // İngilizce
    "pattern", "tutorial", "pdf", "template", "guide", "chart", "instructions", 
    "recipe", "how to", "video", "link", "shop", "etsy", "buy", "where", 
    "please", "where to buy", "cost", "price", "purchase", "order",
    
    // Türkçe
    "anlatım", "tarif", "yapılışı", "nereden", "link", "fiyat",
    
    // İspanyolca  
    "patrón", "plantilla", "instrucciones", "receta", "como hacer", "donde", 
    "por favor", "comprar", "precio", "tienda",
    
    // Fransızca
    "patron", "tutoriel", "modèle", "comment faire", "s'il vous plaît", 
    "acheter", "où", "boutique", "prix",
    
    // Almanca
    "anleitung", "muster", "schablone", "beschreibung", "wie man", "bitte",
    "kaufen", "wo", "preis", "shop",
    
    // Portekizce
    "padrão", "molde", "instruções", "receita", "como fazer", "onde",
    "por favor", "comprar", "preço", "loja",
    
    // İtalyanca
    "schema", "modello", "istruzioni", "ricetta", "come fare", "dove",
    "per favore", "comprare", "prezzo", "negozio"
];

const SHORT_COMMENT_THRESHOLD = 10;

const ALLOWED_PAGE_IDS = new Set([
    "768328876640929", "757013007687866", "708914999121089", "141535723466",
    "1606844446205856", "300592430012288", "1802019006694158", "105749897807346"
]);

// Yorum Filtreleme Mantığı
function shouldSkipComment(message) {
    if (!message || message === "undefined" || message === "null") return true;
    
    const cleanMessage = message.trim().toLowerCase();
    
    // 10 karakterden uzunsa direkt geçir
    if (cleanMessage.length >= SHORT_COMMENT_THRESHOLD) {
        console.log(`✅ Yorum ${SHORT_COMMENT_THRESHOLD}+ karakter, geçiyor`);
        return false;
    }
    
    // 10 karakterden kısaysa pattern kelimesi ara
    for (const keyword of PATTERN_KEYWORDS) {
        if (cleanMessage.includes(keyword)) {
            console.log(`✅ Kısa yorum ama pattern kelimesi var: "${keyword}"`);
            return false;
        }
    }
    
    // Kısa ve pattern kelimesi yok = ATLA
    console.log(`⛔ Kısa yorum, pattern istemiyor: "${cleanMessage}"`);
    return true;
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
        res.sendStatus(403);
    }
});

// Ana Webhook Handler
app.post("/webhook", async (req, res) => {
    // Hemen OK dön (Facebook timeout önleme)
    res.status(200).send("OK");

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];

    try {
        if (!entry || !changes?.value) {
            return console.log("⛔ Eksik veri");
        }

        const item = changes.value.item;
        const verb = changes.value.verb;
        const pageId = entry.id;
        const fromId = changes.value.from?.id;
        const commentId = changes.value.comment_id;
        const commentMessage = changes.value.message;
        
        console.log(`\n📨 ${item} geldi (${verb}) - ID: ${commentId}`);
        console.log(`💬 Mesaj: ${commentMessage?.substring(0, 50)}...`);

        // Temel kontroller
        if (item !== "comment" || verb !== "add") {
            return console.log("⛔ Yorum değil");
        }
        if (!ALLOWED_PAGE_IDS.has(pageId)) {
            return console.log(`⛔ İzinsiz sayfa: ${pageId}`);
        }
        if (fromId === pageId) {
            return console.log("⛔ Sayfanın kendi yorumu");
        }
        if (!commentId) {
            return console.log("⛔ Comment ID yok");
        }
        if (!commentMessage || commentMessage === "undefined") {
            return console.log("⛔ Mesaj yok");
        }
        
        // Yorum filtreleme
        if (shouldSkipComment(commentMessage)) {
            return console.log("⛔ Basit yorum, atlandı");
        }

        // KRİTİK: SETNX ile atomik duplicate kontrolü
        if (redis) {
            // Race condition önleme - 200ms bekle
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const redisKey = `comment:${commentId}`;
            console.log(`🔍 Redis SETNX kontrolü: ${redisKey}`);
            
            // SETNX - Atomik "varsa ekleme" işlemi
            const result = await redis.set(redisKey, "1", "EX", 2592000, "NX");
            
            if (result === 'OK') {
                console.log(`✅ YENİ YORUM - Redis'e kaydedildi`);
            } else {
                console.log(`⛔ DUPLICATE! Zaten var: ${commentId}`);
                return;
            }
        } else {
            console.error("🚨 Redis yok, duplicate kontrolü yapılamıyor!");
        }

        // Make.com'a gönder
        console.log(`📤 Make.com'a gönderiliyor...`);
        
        try {
            await axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body, {
                timeout: 10000
            });
            console.log("✅ Make.com'a gönderildi");
        } catch (error) {
            console.error(`🚨 Make.com hatası: ${error.message}`);
            // Hata durumunda Redis'ten sil
            if (redis) {
                await redis.del(`comment:${commentId}`);
                console.log(`🗑️ Hata nedeniyle silindi`);
            }
        }

    } catch (error) {
        console.error("🚨 Genel hata:", error);
    }
});

// Test endpoint
app.get("/test-redis/:commentId", async (req, res) => {
    if (!redis) {
        return res.json({ error: "Redis yok" });
    }
    
    const key = `comment:${req.params.commentId}`;
    const value = await redis.get(key);
    const exists = await redis.exists(key);
    
    res.json({
        key,
        value,
        exists: exists === 1,
        ttl: await redis.ttl(key)
    });
});

// Health Check
app.get("/health", async (req, res) => {
    let redisStatus = "Disconnected";
    let keyCount = 0;
    
    if (redis && redis.status === 'ready') {
        redisStatus = "Connected";
        const keys = await redis.keys("comment:*");
        keyCount = keys.length;
    }
    
    res.json({
        status: "OK",
        redis: redisStatus,
        totalComments: keyCount,
        timestamp: new Date().toISOString()
    });
});

app.get("/", (req, res) => {
    res.send(`
        <h1>Facebook Webhook</h1>
        <p>Redis: ${redis?.status === 'ready' ? '✅' : '❌'}</p>
        <p><a href="/health">Health Check</a></p>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda başladı`);
    console.log(`📦 Redis: ${redis ? "Var" : "YOK!"}`);
});
