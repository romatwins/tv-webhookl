import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import morgan from "morgan";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;
const SHARED_SECRET = process.env.SHARED_SECRET;

app.use(bodyParser.json());
app.use(morgan("combined"));

// Healthcheck корень
app.get("/", (req, res) => {
  res.json({ ok: true, service: "tv-webhook", ts: new Date().toISOString() });
});

// Тестовый маршрут
app.get("/test", (req, res) => {
  res.json({ ok: true, endpoint: "/test", ts: Date.now() });
});

// Основной webhook
app.post("/", (req, res) => {
  const headerSecret = req.header("X-Secret");
  const bodySecret = req.body?.secret || req.body?.SECRET || req.body?.sharedSecret;

  const incoming = headerSecret ?? bodySecret ?? "";
  if (!SHARED_SECRET || incoming !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  console.log("Received payload:", JSON.stringify(req.body));
  res.json({ ok: true, received: req.body });
});

app.listen(port, () => {
  console.log(`Webhook started on port ${port}`);
});
