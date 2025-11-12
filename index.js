import express from "express";
import bodyParser from "body-parser";

const app = express();
const port = process.env.PORT || 10000;

// читаем секрет из окружения
const SHARED_SECRET = process.env.SHARED_SECRET;

// принимаем и JSON, и текст (TradingView иногда шлёт text/plain)
app.use(bodyParser.json({ limit: "200kb", type: "application/json" }));
app.use(bodyParser.text({ limit: "200kb", type: "*/*" }));

// универсальный парсер тела
function normalizeBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try { return JSON.parse(trimmed); } catch { return { _raw: trimmed }; }
  }
  return { _raw: raw };
}

// healthchecks
app.get("/", (req, res) => {
  res.json({ ok: true, service: "tv-webhook", ts: new Date().toISOString() });
});

app.get("/test", (req, res) => {
  res.json({ ok: true, endpoint: "/test", ts: Date.now() });
});

// основной приёмник
app.post("/", (req, res) => {
  const body = normalizeBody(req.body);
  const hdrSecret = req.get("X-Secret") || req.get("X-Shared-Secret") || "";

  // секрет может быть либо в заголовке, либо в body.secret
  const bodySecret = body && body.secret ? String(body.secret) : "";
  const provided = hdrSecret || bodySecret;

  if (!SHARED_SECRET) {
    console.error("SHARED_SECRET is not set in environment");
    return res.status(500).json({ ok: false, error: "server_misconfigured" });
  }
  if (!provided || provided !== SHARED_SECRET) {
    console.warn("Unauthorized payload", { provided });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // минимальная проверка схемы
  const p = body || {};
  const required = ["action", "side", "chainId", "srcToken", "dstToken", "amountMode", "amountValue", "slippageBps", "deadlineSec", "symbol", "tf", "signalId"];
  const missing = required.filter(k => !(k in p));
  if (missing.length) {
    console.warn("Invalid payload. Missing fields:", missing);
    return res.status(400).json({ ok: false, error: "invalid_payload", missing });
  }

  console.log("Received payload:", JSON.stringify(p));
  return res.json({ ok: true, received: p });
});

app.listen(port, () => {
  console.log(`Webhook started on port ${port}`);
});
