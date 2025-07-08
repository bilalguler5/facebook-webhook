const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const NEW_POST_WEBHOOK_URL = process.env.NEW_POST_WEBHOOK_URL;
const COMMENT_WEBHOOK_URL = process.env.COMMENT_WEBHOOK_URL;

// Webhook doğrulaması için
app.get('/facebook-webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Gelen webhook verilerini işlemek için
app.post('/facebook-webhook', (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(entry => {
            // --- YENİ EKLENEN LOGLAMA ---
            console.log("-----------------------------------------");
            console.log("Facebook'tan yeni veri geldi. Tüm 'entry' içeriği:");
            console.log(JSON.stringify(entry, null, 2));
            // -----------------------------

            if (entry.changes) {
                entry.changes.forEach(change => {
                    // --- YENİ EKLENEN LOGLAMA ---
                    console.log("Değişiklik (change) verisi işleniyor:");
                    console.log(JSON.stringify(change.value, null, 2));
                    // -----------------------------

                    const itemType = change.value.item;

                    // Yeni Gönderi (Post, Foto, Video) Kontrolü
                    if (['post', 'photo', 'video', 'share'].includes(itemType)) {
                        console.log(`Yeni bir '${itemType}' algılandı. Make.com'a gönderiliyor...`);
                        axios.post(NEW_POST_WEBHOOK_URL, { facebook_data: change.value, entry_data: entry })
                             .catch(err => console.error("Make.com'a YENİ GÖNDERİ verisi gönderilirken hata:", err.message));
                    }
                    // Yeni Yorum Kontrolü
                    else if (itemType === 'comment') {
                        console.log("Yeni bir 'yorum' algılandı. Kimlikler kontrol ediliyor...");
                        const pageId = entry.id;
                        const commenterId = change.value.from.id;

                        // --- YENİ EKLENEN LOGLAMA ---
                        console.log(`Sayfa ID: ${pageId}`);
                        console.log(`Yorum Yapan ID: ${commenterId}`);
                        // -----------------------------

                        if (String(commenterId) === String(pageId)) {
                            console.log("KARŞILAŞTIRMA SONUCU: Yorumu yapan sayfanın kendisi. Bu yorum Make.com'a GÖNDERİLMEYECEK.");
                        } else {
                            console.log("KARŞILAŞTIRMA SONUCU: Yorumu yapan bir kullanıcı. Make.com'a GÖNDERİLİYOR...");
                            axios.post(COMMENT_WEBHOOK_URL, { facebook_data: change.value, entry_data: entry })
                                 .catch(err => console.error("Make.com'a YORUM verisi gönderilirken hata:", err.message));
                        }
                    }
                });
            }
        });

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

app.listen(PORT, () => console.log(`Webhook sunucusu ${PORT} portunda çalışıyor`));
