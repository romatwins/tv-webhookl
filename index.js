const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const port = process.env.PORT || 10000;

app.use(bodyParser.json());

// Тестовый маршрут
app.get("/test", (req, res) => {
  res.json({ status: "ok", message: "Webhook active and reachable" });
});

// Основной webhook
app.post("/", (req, res) => {
  console.log("Received data:", req.body);
  res.json({ status: "success", received: req.body });
});

app.listen(port, () => {
  console.log(`Webhook started on port ${port}`);
});
