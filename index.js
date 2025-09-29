const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Redis Bağlantısı (URL/Host-Port)
let redis = null;

if (process.env.REDIS_URL || (process.env.REDISHOST && process.env.REDISPORT)) {
    const redisConfig = process.env.REDIS_URL 
        ? process.env.REDIS_URL 
        : {
            host: process.env.REDISHOST,
            port: parseInt(process.env.REDISPORT),
            password: process.env.REDISPASSWORD || undefined,
        };
        
    redis = new Redis(redisConfig, {
        // Bağlantı ayarları
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
        retryStrategy: (times) => Math.min(times * 50, 2000)
    });
    console.log("✅ Redis'e bağlanılıyor...");
} else {
    console.error("🚨 HATA: Redis bağlantı değişkenleri (REDIS_URL veya REDISHOST/REDISPORT) eksik!");
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

// Pattern Anahtar Kelimeleri (Türkçe ve yabancı diller dahil)
const PATTERN_KEYWORDS = [
    "pattern", "tutorial", "pdf", "template", "description", "guide", "chart", 
    "instructions", "recipe", "how to", "video", "anlatım", "tarif",
    "patrón", "plantilla", "instrucciones", "receta", "como hacer",
    "padrão", "molde", "instruções", "receita", "como fazer",
    "schema", "modello", "istruzioni", "ricetta", "come fare", "spiegazioni",
    "anleitung", "muster", "schablone", "beschreibung", "wie man",
    "patron", "tutoriel", "modèle", "comment faire",
    // İngilizce kısaltmalar
    "where i get the pattern", "where i find the pattern", "do you have the pattern",
    "can i have the pattern", "how do i get the pattern",
];

const SHORT_COMMENT_THRESHOLD = 10;
const TURKISH_SIMPLE_PATTERNS = [
    /^(merhaba|teşekkürler|güzel|harika|süper|çok güzel|bayıldım)$/i,
    /^(eline sağlık|ellerine sağlık|çok beğendim|nasıl yapılır|yapılışı|tarifi)$/i,
    /^(ok+|okay|tamam)$/i
];

// İzinli Facebook Sayfa ID'leri
const ALLOWED_PAGE_IDS = new Set([
    "768328876640929", "757013007687866", "708914999121089", "141535723466",
    "1606844446205856", "300592430012288", "1802019006694158", "105749897807346"
]);

// Basit Yorum Kontrolü (Pattern anahtar kelimeleri güncellendi)
function isSimpleComment(message) {
    if (!message || message === "undefined" || message === "null") return true;
    
    const cleanMessage = message.trim().toLowerCase();
    
    // Pattern kelimelerini kontrol et
    for (const keyword of PATTERN_KEYWORDS) {
        if (cleanMessage.includes(keyword)) {
            console.log(`✅ Pattern anahtar kelimesi bulundu: "${keyword}"`);
            return false;
        }
    }
    
    // Sadece Pattern anahtar kelimesi geçmeyen yorumlar için aşağıdaki kontrolleri uygula

    // Çok kısa yorumları filtrele
    if (cleanMessage.length < SHORT_COMMENT_THRESHOLD) {
        return true;
    }
    
    // Basit ve olumlu yorumları filtrele (Pattern isteği içermiyorsa)
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
    // Facebook webhook'tan gelen veriyi anında kabul et ve arka planda işle
    res.status(200).send("OK: İşleniyor");

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];

    try {
        if (!entry || !changes?.value) {
            return console.log("⛔ Eksik veya geçersiz Facebook verisi.");
        }

        const item = changes.value.item;
        const verb = changes.value.verb;
        const pageId = entry.id;
        const fromId = changes.value.from?.id;
        const commentId = changes.value.comment_id;
        const commentMessage = changes.value.message;
        
        console.log(`📨 Facebook'tan ${item} verisi geldi (Eylem: ${verb})`);

        // 1. Sadece yeni yorumları işle
        if (item !== "comment" || verb !== "add") {
            return console.log(`⛔ ${item} veya ${verb} işlemi. Yorum değil, atlanıyor.`);
        }

        // 2. Sayfa ve Kullanıcı Kontrolü
        if (!ALLOWED_PAGE_IDS.has(pageId)) {
            return console.log(`⛔ İzinsiz sayfa: ${pageId}. Atlanıyor.`);
        }
        if (fromId === pageId) {
            return console.log("⛔ Sayfanın kendi yorumu. Atlanıyor.");
        }
        if (!commentId) {
            return console.log("⛔ Comment ID yok. Atlanıyor.");
        }
        if (!commentMessage || commentMessage === "undefined") {
            return console.log("⛔ Mesaj içeriği yok. Atlanıyor.");
        }
        
        // 3. Basit yorum kontrolü
        if (isSimpleComment(commentMessage)) {
            return console.log(`⛔ Basit yorum veya Pattern isteği içermeyen yorum: "${commentMessage.substring(0, 50)}...". Atlanıyor.`);
        }
        
        // 4. Redis Duplicate Kontrolü (ATOMİK VE KESİN ÇÖZÜM)
        if (redis) {
            const redisKey = `comment:${commentId}`;
            console.log(`🔍 Redis kontrol (Atomik SET NX): ${redisKey}`);
            
            // SETNX (Set if Not Exists) kullanarak atomik kontrol
            const setResult = await redis.set(redisKey, "1", "EX", 2592000, "NX");
            
            if (setResult === 'OK') {
                console.log(`✅ YENİ YORUM. Redis'e kaydedildi: ${commentId}`);
            } else if (setResult === null) {
                console.log(`⛔ DUPLICATE BULUNDU! ${commentId}. İşlem durduruluyor.`);
                return; // Duplicate olduğu için işlemi sonlandır
            } else {
                console.log(`⚠️ Redis'ten beklenmeyen sonuç: ${setResult}. Güvenlik için duplicate kabul edildi.`);
                return;
            }
        } else {
            console.error("🚨 Redis bağlantısı yok! Duplicate kontrolü atlandı.");
            // Redis yoksa Make.com'a gönderme işlemi devam edecek (riskli)
        }

        // 5. Make.com'a gönder
        console.log(`✅ Pattern yorumu, Make.com'a gönderiliyor: ${commentId}`);

        try {
            await axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body, {
                timeout: 10000 // 10 saniye zaman aşımı
            });
            console.log("✅ Make.com'a başarıyla gönderildi");
        } catch (error) {
            console.error(`🚨 Make.com hatası: ${error.message}.`);
            
            // Make.com'a gönderme başarısız olursa, tekrar deneme şansı vermek için
            // Redis'teki kaydı SİL. (Bu, aynı yorumun daha sonra yeniden işlenmesine olanak tanır.)
            if (redis) {
                await redis.del(`comment:${commentId}`);
                console.log(`🗑️ Make.com hatası nedeniyle Redis'ten silindi: ${commentId}`);
            }
        }

    } catch (error) {
        console.error("🚨 İşleme sırasında genel bir hata oluştu:", error);
    }
});

// Test endpoint
app.get("/test-redis/:commentId", async (req, res) => {
    if (!redis) {
        return res.json({ error: "Redis not connected" });
    }
    
    const commentId = req.params.commentId;
    const key = `comment:${commentId}`;
    const value = await redis.get(key);
    
    res.json({
        key: key,
        value: value,
        valueType: typeof value,
        exists: value !== null && value !== undefined,
        isOne: value === "1" || value === 1,
        ttl: await redis.ttl(key) // Kalan ömrü saniye cinsinden gösterir
    });
});

// Health Check
app.get("/health", async (req, res) => {
    try {
        let redisStatus = "Disconnected";
        let redisKeyCount = 0;
        
        if (redis && redis.status === 'ready') {
            const testKey = `health:${Date.now()}`;
            const result = await redis.set(testKey, "test", "EX", 10, "NX");
            if (result === 'OK' || await redis.get(testKey) === "test") {
                redisStatus = "OK";
                await redis.del(testKey);
                
                const keys = await redis.keys("comment:*");
                redisKeyCount = keys.length;
            } else {
                 redisStatus = "Test Failed";
            }
        }
        
        res.json({
            status: "OK",
            redis_status: redisStatus,
            redis_comment_keys: redisKeyCount,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({
            status: "ERROR",
            redis_status: "Error",
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Facebook OAuth Endpoints (Mevcut haliyle bırakıldı)
const APP_ID = "1203840651490478";
const APP_SECRET = "de926e19322760edf3b377e0255469de";
const REDIRECT_URI = "https://facebook-webhook-production-410a.up.railway.app/auth";

app.get("/", (req, res) => {
    const oauthLink = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&scope=pages_manage_metadata,pages_read_engagement,pages_show_list,pages_manage_posts,pages_read_user_content&response_type=code`;
    res.send(`
        <html>
        <head><title>Facebook Webhook</title></head>
        <body style="font-family: Arial; padding: 20px;">
            <h1>Facebook Webhook Sistemi</h1>
            <p><strong>Redis:</strong> ${redis && redis.status === 'ready' ? "✅ Bağlı ve Hazır" : "❌ Bağlı Değil/Hazır Değil"}</p>
            <p><a href="${oauthLink}">👉 Facebook Sayfa Yetkisi Ver</a></p>
            <p><a href="/health">📊 Sistem Durumu</a></p>
        </body>
        </html>
    `);
});

app.get("/auth", async (req, res) => {
    // ... OAuth akışı kodunuz ...
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
        res.send("✅ Token alındı!");
    } catch (err) {
        console.error("Token hatası:", err.message);
        res.send("Token alınamadı");
    }
});


// Server Başlat
app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda başladı`);
});
