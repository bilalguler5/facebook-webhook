const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// --- DEĞİŞKENLER (Railway "Variables" sekmesinden okunacak) ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const COMMENT_WEBHOOK_URL = process.env.COMMENT_WEBHOOK_URL;
const NEW_POST_WEBHOOK_URL = process.env.NEW_POST_WEBHOOK_URL;

// Facebook imzasını doğrulamak için ham gövdeyi (raw body) alıyoruz
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// --- SAĞLIK KONTROLÜ (HEALTH CHECK) ENDPOINT'İ ---
// Railway'in uygulamanın "canlı" olduğunu anlaması için.
app.get('/', (req, res) => {
  res.status(200).send('Webhook server is running and healthy.');
});


// --- WEBHOOK DOĞRULAMA (GET) ---
app.get('/facebook-webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- WEBHOOK OLAYLARINI ALMA (POST) ---
app.post('/facebook-webhook', (req, res) => {
  if (!verifyRequestSignature(req, res, req.headers['x-hub-signature-256'])) {
    return;
  }

  const body = req.body;
  if (body.object === 'page') {
    body.entry.forEach(entry => {
      entry.changes.forEach(change => {
        if (change.field === 'feed') {
          const itemData = change.value;
          if (itemData.item === 'post' && itemData.verb === 'add') {
            console.log("Yeni bir gönderi algılandı.");
            handleNewPost(itemData);
          } else if (itemData.item === 'comment' && itemData.verb === 'add') {
            console.log("Yeni bir yorum algılandı.");
            handleNewComment(itemData);
          } else {
            console.log(`İşlenmeyen olay türü: [${itemData.item}] - [${itemData.verb}]. Atlanıyor.`);
          }
        }
      });
    });
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// --- YENİ YORUMU İŞLEYEN FONKSİYON ---
async function handleNewComment(data) {
  const commentId = data.comment_id;
  const pageId = data.post_id.split('_')[0];

  if (!PAGE_ACCESS_TOKEN) {
    console.error("HATA: PAGE_ACCESS_TOKEN ayarlanmamış!");
    return;
  }
  
  try {
    const url = `https://graph.facebook.com/v20.0/${commentId}?fields=from&access_token=${PAGE_ACCESS_TOKEN}`;
    const response = await axios.get(url);
    const commenterId = response.data.from.id;

    if (commenterId === pageId) {
      console.log("--> Yorum Sayfa Sahibi tarafından yapıldı. İşlem yapılmayacak.");
    } else {
      console.log("--> Yorum bir ziyaretçi tarafından yapıldı. Make.com otomasyonu tetikleniyor...");
      if (COMMENT_WEBHOOK_URL) {
        await axios.post(COMMENT_WEBHOOK_URL, data);
        console.log("Yorum verisi başarıyla Make.com'a gönderildi.");
      } else {
        console.warn("UYARI: COMMENT_WEBHOOK_URL ayarlanmamış.");
      }
    }
  } catch (error) {
    console.error("Yorum işlenirken hata oluştu:", error.response ? error.response.data.error.message : error.message);
  }
}

// --- YENİ GÖNDERİYİ İŞLEYEN FONKSİYON ---
async function handleNewPost(data) {
    console.log("--> Yeni gönderi otomasyonu tetikleniyor...");
    if (NEW_POST_WEBHOOK_URL) {
        try {
            await axios.post(NEW_POST_WEBHOOK_URL, data);
            console.log("Gönderi verisi başarıyla Make.com'a gönderildi.");
        } catch (error) {
            console.error("Gönderi verisi gönderilirken hata oluştu:", error.message);
        }
    } else {
        console.warn("UYARI: NEW_POST_WEBHOOK_URL ayarlanmamış.");
    }
}

// --- FACEBOOK İSTEK DOĞRULAMA ---
function verifyRequestSignature(req, res, signature) {
  if (!signature) {
    console.error("İstek imzasız geldi, reddediliyor.");
    res.sendStatus(403);
    return false;
  }
  if (!APP_SECRET) {
      console.error("UYARI: APP_SECRET tanımlı değil. İmza doğrulanamıyor.");
      res.sendStatus(403);
      return false; 
  }

  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(req.rawBody);
  const expectedSignature = `sha256=${hmac.digest('hex')}`;

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      console.error("İmza eşleşmedi, istek reddediliyor.");
      res.sendStatus(403);
      return false;
  }
  return true;
}

app.listen(PORT, () => {
  console.log(`Webhook sunucusu ${PORT} portunda dinleniyor...`);
});
