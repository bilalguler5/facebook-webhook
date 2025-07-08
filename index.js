const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// --- GEREKLİ DEĞİŞKENLER (Railway "Variables" panelinden alınır) ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const COMMENT_WEBHOOK_URL = process.env.COMMENT_WEBHOOK_URL; // Yorumlara cevap otomasyonu için
const NEW_POST_WEBHOOK_URL = process.env.NEW_POST_WEBHOOK_URL;  // İlk yorum yapma otomasyonu için

// Gelen isteklerin gövdesini JSON olarak okumak için middleware
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // İmza doğrulaması için ham gövdeyi sakla
  }
}));

// --- ROTALAR (URL Endpoints) ---

// 1. Sağlık Kontrolü Rotası (Railway'in uygulamayı kapatmaması için)
app.get('/', (req, res) => {
  res.status(200).send('Webhook server is running and healthy.');
});

// 2. Webhook Doğrulama Rotası (Facebook ile ilk kurulum için)
app.get('/facebook-webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 3. Ana Webhook Olay Dinleme Rotası (Tüm bildirimler buraya gelir)
app.post('/facebook-webhook', (req, res) => {
  // İsteğin gerçekten Facebook'tan geldiğini doğrula
  if (!verifyRequestSignature(req, res, req.headers['x-hub-signature-256'])) {
    return;
  }

  const body = req.body;
  if (body.object === 'page') {
    body.entry.forEach(entry => {
      entry.changes.forEach(change => {
        if (change.field === 'feed') {
          const eventData = change.value;
          
          // GÖREV 1: Yeni bir gönderi, fotoğraf, video veya link paylaşımı mı?
          const newPostTypes = new Set(['post', 'photo', 'video', 'share']);
          if (newPostTypes.has(eventData.item) && eventData.verb === 'add') {
            console.log(`Yeni bir ${eventData.item} algılandı. İlk yorum otomasyonu tetikleniyor...`);
            handleNewPublication(eventData);
          } 
          // GÖREV 2: Yeni bir yorum mu?
          else if (eventData.item === 'comment' && eventData.verb === 'add') {
            console.log("Yeni bir yorum algılandı. Yorum cevap otomasyonu için kontrol ediliyor...");
            handleNewComment(eventData);
          } 
          // Diğer durumları (beğeni, düzenleme vb.) görmezden gel
          else {
            console.log(`İşlenmeyen olay: [${eventData.item}/${eventData.verb}]. Atlanıyor.`);
          }
        }
      });
    });
    res.status(200).send('EVENT_RECEIVED'); // Facebook'a "aldım, teşekkürler" de
  } else {
    res.sendStatus(404);
  }
});


// --- GÖREV FONKSİYONLARI ---

/**
 * GÖREV 1: Yeni bir gönderi, fotoğraf, video veya link paylaşıldığında çalışır.
 * Amacı: Make.com'daki "ilk yorum yapma" otomasyonunu tetiklemek.
 */
async function handleNewPublication(data) {
  // Farklı gönderi türlerinden gelen ID'leri tek bir standart ID'de birleştirelim
  // Make.com'un kafası karışmasın.
  const publicationId = data.post_id || data.photo_id || data.video_id || data.share_id;

  if (!publicationId) {
    console.warn("Yayının ID'si bulunamadı. Make.com'a gönderim atlandı.", data);
    return;
  }
  
  if (NEW_POST_WEBHOOK_URL) {
    const payload = { ...data, unified_id: publicationId }; // Make.com için standart bir ID alanı oluşturduk
    try {
      await axios.post(NEW_POST_WEBHOOK_URL, payload);
      console.log(`--> [İlk Yorum] Veri (ID: ${publicationId}) başarıyla Make.com'a gönderildi.`);
    } catch (error) {
      console.error("--> [İlk Yorum] Make.com'a veri gönderilirken hata oluştu:", error.message);
    }
  } else {
    console.warn("--> [İlk Yorum] NEW_POST_WEBHOOK_URL ayarlanmamış.");
  }
}

/**
 * GÖREV 2: Yeni bir yorum yapıldığında çalışır.
 * Amacı: Yorumun bir ziyaretçi tarafından yapılıp yapılmadığını kontrol edip
 * Make.com'daki "yoruma cevap verme" otomasyonunu tetiklemek.
 */
async function handleNewComment(data) {
  if (!data.comment_id) {
    console.warn("Yorum verisinde 'comment_id' bulunamadı. İşlem atlanıyor.", data);
    return;
  }
  
  try {
    const commentId = data.comment_id;
    const pageId = data.post_id.split('_')[0];
    const url = `https://graph.facebook.com/v20.0/${commentId}?fields=from{id,name}&access_token=${PAGE_ACCESS_TOKEN}`;
    const response = await axios.get(url);

    if (response.data && response.data.from) {
      const commenterId = response.data.from.id;

      if (commenterId === pageId) {
        console.log("--> [Yorum Cevap] Yorum Sayfa Sahibi tarafından yapıldı. Atlanıyor.");
      } else {
        console.log("--> [Yorum Cevap] Ziyaretçi yorumu! Make.com tetikleniyor...");
        if (COMMENT_WEBHOOK_URL) {
          const payload = { ...data, commenter: response.data.from };
          await axios.post(COMMENT_WEBHOOK_URL, payload);
          console.log("--> [Yorum Cevap] Veri başarıyla Make.com'a gönderildi.");
        } else {
          console.warn("--> [Yorum Cevap] COMMENT_WEBHOOK_URL ayarlanmamış.");
        }
      }
    } else {
      console.log("--> [Yorum Cevap] Yorumu yapan kişi bilgisi alınamadı (silinmiş olabilir). Atlanıyor.");
    }
  } catch (error) {
    console.error("--> [Yorum Cevap] Yorum işlenirken API hatası oluştu:", error.response ? error.response.data.error.message : "Bilinmeyen Hata");
  }
}

// --- GÜVENLİK FONKSİYONU ---
function verifyRequestSignature(req, res, signature) {
  if (!signature || !APP_SECRET) {
    console.error("Güvenlik hatası: İstek imzasız veya APP_SECRET tanımsız.");
    res.sendStatus(403);
    return false;
  }
  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(req.rawBody);
  const expectedSignature = `sha256=${hmac.digest('hex')}`;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    console.error("Güvenlik hatası: İmza eşleşmedi.");
    res.sendStatus(403);
    return false;
  }
  return true;
}

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`Webhook sunucusu ${PORT} portunda dinleniyor... Her şey hazır!`);
});
