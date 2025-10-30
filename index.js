const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");

// ... (Mevcut kodunuzun başı: app, PORT, redis bağlantısı... hepsi aynı)
// ...
// ... (MAn_KEYWORDS, SHORT_COMMENT_THRESHOLD, ALLOWED_PAGE_IDS... hepsi aynı)
// ...
// ... (shouldSkipComment fonksiyonu... aynı)
// ...
// ... (app.get("/webhook") doğrulaması... aynı)
// ...

// MEVCUT Webhook URL'niz
const PATTERN_REQUEST_WEBHOOK_URL = "https://hook.us2.make.com/rvcgwaursmfmu8gn2mkgxdkvrhyu8yay";

// YENİ: Fotoğraf webhook'u için yeni Make.com senaryonuzun URL'si
// Bunu kendi Make.com URL'niz ile değiştirmelisiniz!
const PHOTO_REQUEST_WEBHOOK_URL = "https://hook.us2.make.com/myjvwo4ouxtvdx8excar5myzy9bjsyhs";


// ... (app.get("/webhook") fonksiyonunuz burada... aynı) ...


// Ana Webhook Handler - GÜNCELLENDİ
app.post("/webhook", async (req, res) => {
    // Hemen OK dön (Facebook timeout önleme) - Bu aynı kalıyor
    res.status(200).send("OK");

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]; // 'change' -> 'changes' (orijinaldeki gibi)

    try {
        if (!entry || !changes?.value) {
            return console.log("⛔ Eksik veri");
        }

        // Değerleri en üstte alalım
        const value = changes.value;
        const item = value.item;
        const verb = value.verb;
        const pageId = entry.id;
        
        // YENİ YÖNLENDİRİCİ MANTIĞI
        // ----------------------------------------------------

        // 1. DURUM: YORUM GELDİYSE (Mevcut kodunuz)
        // ----------------------------------------------------
        if (item === "comment" && verb === "add") {
            
            // TAŞINDI: Yorumla ilgili değişkenler artık bu blok içinde
            const fromId = value.from?.id;
            const commentId = value.comment_id;
            const commentMessage = value.message;

            console.log(`\n📨 ${item} geldi (${verb}) - ID: ${commentId}`);
            console.log(`💬 Mesaj: ${commentMessage?.substring(0, 50)}...`);

            // TAŞINDI: Temel kontroller (Mevcut kodunuz)
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
            
            // TAŞINDI: Yorum filtreleme (Mevcut kodunuz)
            if (shouldSkipComment(commentMessage)) {
                return console.log("⛔ Basit yorum, atlandı");
            }

            // TAŞINDI: KRİTİK: SETNX ile atomik duplicate kontrolü (Mevcut kodunuz)
            if (redis) {
                await new Promise(resolve => setTimeout(resolve, 200));
                
                const redisKey = `comment:${commentId}`;
                console.log(`🔍 Redis SETNX kontrolü: ${redisKey}`);
                
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

            // TAŞINDI: Make.com'a gönder (Mevcut kodunuz)
            console.log(`📤 Make.com'a (YORUM) gönderiliyor...`);
            
            try {
                await axios.post(PATTERN_REQUEST_WEBHOOK_URL, req.body, {
                    timeout: 10000
                });
                console.log("✅ Make.com'a (YORUM) gönderildi");
            } catch (error) {
                console.error(`🚨 Make.com (YORUM) hatası: ${error.message}`);
                if (redis) {
                    await redis.del(`comment:${commentId}`);
                    console.log(`🗑️ Hata nedeniyle (YORUM) silindi`);
                }
            }

        } // Yorum bloku bitti

        // ----------------------------------------------------
        // 2. DURUM: FOTOĞRAF GELDİYSE (Yeni kod)
        // ----------------------------------------------------
        else if (item === "photo" && verb === "add") {
            
            // YENİ: Fotoğraf postuyla ilgili verileri al
            const fromId = value.from?.id;
            const postId = value.post_id; // Bu genellikle fotoğrafın ID'sidir
            const photoUrl = value.link; // Paylaşılan fotoğrafın URL'si
            
            console.log(`\n📸 FOTOĞRAF postu geldi (${verb}) - ID: ${postId}`);
            console.log(`🔗 URL: ${photoUrl}`);

            // YENİ: Kontroller
            if (!ALLOWED_PAGE_IDS.has(pageId)) {
                return console.log(`⛔ İzinsiz sayfa (FOTO): ${pageId}`);
            }
            
            // Not: Fotoğraf postlarında 'fromId'nin 'pageId' ile aynı olmasını bekleriz.
            // Bu yüzden 'fromId === pageId' kontrolünü burada yapmıyoruz.
            
            if (!postId) {
                return console.log("⛔ Post ID yok (FOTO)");
            }

            // YENİ: Fotoğraflar için de duplicate kontrolü (Post ID'ye göre)
            if (redis) {
                const redisKey = `post:${postId}`;
                console.log(`🔍 Redis SETNX kontrolü (FOTO): ${redisKey}`);
                
                const result = await redis.set(redisKey, "1", "EX", 2592000, "NX");
                
                if (result !== 'OK') {
                    console.log(`⛔ DUPLICATE POST! Zaten var (FOTO): ${postId}`);
                    return;
                }
                console.log(`✅ YENİ POST - Redis'e kaydedildi (FOTO)`);
            }

            // YENİ: Make.com'daki YENİ webhook'a gönder
            console.log(`📤 Make.com'a (FOTO) gönderiliyor...`);
            
            try {
                // YENİ: Farklı URL'ye post atıyoruz
                await axios.post(PHOTO_REQUEST_WEBHOOK_URL, req.body, {
                    timeout: 10000
                });
                console.log("✅ Make.com'a (FOTO) gönderildi");
            } catch (error) {
                console.error(`🚨 Make.com (FOTO) hatası: ${error.message}`);
                if (redis) {
                    // Hata durumunda Redis'ten sil
                    await redis.del(`post:${postId}`);
                    console.log(`🗑️ Hata nedeniyle (FOTO) silindi`);
                }
            }
            
        } // Fotoğraf bloku bitti

        // ----------------------------------------------------
        // 3. DURUM: Diğer (video, status vb.)
        // ----------------------------------------------------
        else {
            if(item) {
                console.log(`⛔ İşlenmeyen item/verb: ${item}/${verb}, atlandı.`);
            } else {
                console.log(`⛔ İşlenmeyen field: ${changes.field}, atlandı.`);
            }
        }

    } catch (error) {
        console.error("🚨 Genel hata:", error);
    }
});

// ... (Geri kalan kodunuz: /test-redis, /health, /, app.listen... hepsi aynı)
// ...
