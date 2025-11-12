import express from "express";
import morgan from "morgan";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;
const SHARED = process.env.SHARED_SECRET || "";

// базовые middleware
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// простая авторизация по секрету (из заголовка X-Secret или поля body.secret)
function checkSecret(req, res, next) {
  if (!SHARED) return next(); // если секрет не задан в ENV — пропускаем
  const got =
    req.get("X-Secret") ||
    (req.body && typeof req.body.secret === "string" ? req.body.secret : "");
  if (got !== SHARED) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// корень — для проверки из браузера
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "tv-webhook",
    ts: new Date().toISOString(),
  });
});

// тестовый GET
app.get("/test", (_req, res) => {
  res.json({ ok: true, endpoint: "/test", ts: Date.now() });
});

// healthcheck для Render (необязательно, но удобно)
app.get("/health", (_req, res) => res.send("ok"));

// основной webhook (сюда шлёт TradingView)
app.post("/", checkSecret, (req, res) => {
  // Логируем вход
  console.log("TV payload:", JSON.stringify(req.body));

  // Отвечаем сразу; бизнес-логику добавишь позже
  res.json({ ok: true, received: req.body });
});

// 404 для остальных путей
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
});

app.listen(port, () => {
  console.log(`Webhook started on port ${port}`);
});
