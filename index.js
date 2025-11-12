// index.js  — ES Modules
import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

// секрет берём из переменной окружения SHARED_SECRET (на Render ты уже задал r6m1tw5ns)
const SHARED = process.env.SHARED_SECRET || "";

// ПИНГ: GET /
app.get("/", (req, res) => {
  res.json({ ok: true, service: "tv-webhook", ts: new Date().toISOString() });
});

// ПИНГ: GET /test
app.get("/test", (req, res) => {
  res.json({ ok: true, endpoint: "/test", ts: Date.now() });
});

// Основной вебхук: POST /
app.post("/", (req, res) => {
  const hdrSecret = req.get("X-Secret") || req.get("x-secret") || "";
  if (!SHARED || hdrSecret !== SHARED) {
    console.log("Unauthorized payload:", req.body);
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  console.log("Received payload:", req.body);
  // Здесь потом добавим отправку транзакции
  res.json({ ok: true, received: req.body });
});

// ВАЖНО: слушаем именно PORT из окружения
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Webhook started on port ${PORT}`);
});
