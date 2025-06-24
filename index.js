const express = require("express");
const axios = require("axios"); // Make'e veri göndermek için

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const VERIFY_TOKEN = "Allah1dir.,";

// Webhook doğrulama
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

// Facebook OAuth sonrası sayfaları göstermek için HTML döndür
app.get('/', (req, res) => {
  res.send(`
    <html>
      <body>
        <h2>Facebook OAuth başarılı, sayfalar getiriliyor...</h2>
        <script>
          const hash = window.location.hash;
          const params = new URLSearchParams(hash.slice(1));
          const accessToken = params.get('access_token');

          if (accessToken) {
            fetch('https://graph.facebook.com/v19.0/me/accounts?access_token=' + accessToken)
              .then(res => res.json())
              .then(data => {
                document.body.innerHTML += '<h3>Sayfalar:</h3>';
                document.body.innerHTML += '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
              })
              .catch(err => {
                document.body.innerHTML += '<p style="color:red;">Veri alınamadı: ' + err + '</p>';
              });
          } else {
            document.body.innerHTML += '<p st
