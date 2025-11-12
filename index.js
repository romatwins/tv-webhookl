import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import morgan from "morgan";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;
const SHARED_SECRET = process.env.SHARED_SECRET || "r6m1tw5ns"; // твой секрет по умолчанию

app.use(bodyParser.json());
app.use(morgan("combined"));

// Проверка доступности сервиса
app.get("/", (req, res) => {
  res.json({ ok: true, service: "tv-webhook", ts: new Date().toISOString() });
});

// Тестовый маршрут
app.get("/test", (req, res) => {
  res.json({ ok: true, endpoint: "/test", ts: Date.now() });
});

// Основной webhook
app.post("/", (req, res) => {
  try {
    const secret = (req.body && req.body.secret) || "";
    if (secret !== process.env.SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Сформируем объект без секрета для логов/дальнейшей обработки
    const { secret: _omit, ...clean } = req.body;

    // Короткая маска секрета в логах
    const mask = secret.length >= 4 ? secret.slice(0,2) + "***" + secret.slice(-2) : "***";
    console.log("Received payload:", { ...clean, secret: mask });

    // TODO: здесь можно форвардить clean в биржу/бота/БД

    res.json({ ok: true, received: clean });
  } catch (e) {
    console.error("Handler error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(port, () => {
  console.log(`Webhook started on port ${port}`);
});
