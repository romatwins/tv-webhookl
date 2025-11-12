import express from "express";
import morgan from "morgan";

const app = express();
const port = process.env.PORT || 10000;

// лог и парсер
app.use(morgan("tiny"));
app.use(express.json());

// корневой healthcheck (браузер)
app.get("/", (req, res) => {
  res.json({ ok: true, service: "tv-webhook", ts: new Date().toISOString() });
});

// тестовый путь (браузер)
app.get("/test", (req, res) => {
  res.json({ status: "ok", endpoint: "/test", ts: Date.now() });
});

// основной webhook (принимает POST от TradingView)
app.post("/", (req, res) => {
  console.log("Received data:", req.body);
  res.json({ status: "success", received: req.body });
});

// старт
app.listen(port, () => {
  console.log(`Webhook started on port ${port}`);
});
