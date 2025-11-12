import express from "express";
import morgan from "morgan";

const app = express();
const port = process.env.PORT || 10000;

// Middleware
app.use(morgan("tiny"));
app.use(express.json());

// Health-check и быстрая проверка
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "tv-webhook",
    ts: new Date().toISOString()
  });
});

// Тестовый маршрут
app.get("/test", (req, res) => {
  res.json({ status: "ok", endpoint: "/test", ts: Date.now() });
});

// Основной webhook — оставляю оба пути для удобства
app.post("/", (req, res) => {
  console.log("POST / payload:", req.body);
  res.json({ status: "success", received: req.body });
});

app.post("/hook", (req, res) => {
  console.log("POST /hook payload:", req.body);
  res.json({ status: "success", received: req.body });
});

// 404 на всё остальное — чтобы видеть точный путь
app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Route not found", path: req.path });
});

app.listen(port, () => {
  console.log(`Webhook started on port ${port}`);
});
