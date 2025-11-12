// index.js — Render ready, Dry-Run автотрейд с MetaMask ключом
// Node 18+; ESM; ethers v6

import express from "express";
import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet } from "ethers";

// ——— Конфиг из ENV ———
const PORT = process.env.PORT || 10000;
const SHARED_SECRET = process.env.SHARED_SECRET || "";        // r6m1tw5ns
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY || "").trim(); // безопасно хранится в Render ENV
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

// RPC по сетям. Заполни значения в Render ENV если ещё не заполнил.
const RPCS = {
  1: process.env.RPC_ETH || "",     // Ethereum mainnet
  8453: process.env.RPC_BASE || "", // Base mainnet
  42161: process.env.RPC_ARB || ""  // Arbitrum One
};

// ——— Инициализация ———
const app = express();
app.use(bodyParser.json({ limit: "200kb", type: "application/json" }));
app.use(bodyParser.text({ limit: "200kb", type: "*/*" }));

// Универсальный парсер тела. TradingView иногда шлёт text/plain.
function normalizeBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    try { return JSON.parse(t); } catch { return { _raw: t }; }
  }
  return { _raw: raw };
}

// Провайдер по chainId
function getProvider(chainId) {
  const url = RPCS[Number(chainId)];
  if (!url) throw new Error(`RPC not configured for chainId ${chainId}`);
  return new JsonRpcProvider(url, Number(chainId));
}

// Кошелёк из PRIVATE_KEY
function getWallet(provider) {
  if (!PRIVATE_KEY_RAW) throw new Error("PRIVATE_KEY is not set");
  const pk = PRIVATE_KEY_RAW.startsWith("0x") ? PRIVATE_KEY_RAW : "0x" + PRIVATE_KEY_RAW;
  return new Wallet(pk, provider);
}

// ——— Health ———
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "tv-webhook", ts: new Date().toISOString() });
});

app.get("/test", (_req, res) => {
  res.json({ ok: true, endpoint: "/test", ts: Date.now() });
});

// ——— Основной приёмник ———
app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body) || {};
    // Секрет разрешаем в заголовке и в теле
    const hdrSecret = req.get("X-Secret") || req.get("x-secret") || "";
    const bodySecret = typeof body.secret === "string" ? body.secret : "";
    const provided = hdrSecret || bodySecret;

    if (!SHARED_SECRET) {
      return res.status(500).json({ ok: false, error: "server_misconfigured_no_secret" });
    }
    if (provided !== SHARED_SECRET) {
      // маскируем секрет в логах
      const mask = provided ? provided.slice(0, 2) + "***" + provided.slice(-2) : "";
      console.warn("Unauthorized payload", { secret: mask });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Минимальная схема для твоего Pine JSON
    const p = body;
    const required = [
      "action", "side", "chainId",
      "srcToken", "dstToken",
      "amountMode", "amountValue",
      "slippageBps", "deadlineSec",
      "symbol", "tf", "signalId"
    ];
    const missing = required.filter(k => !(k in p));
    if (missing.length) {
      console.warn("Invalid payload. Missing fields:", missing);
      return res.status(400).json({ ok: false, error: "invalid_payload", missing });
    }

    // Поднимаем провайдера и кошелёк. В DRY_RUN сделок не отправляем.
    const provider = getProvider(p.chainId);
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();

    // Делаем безопасный превью-подпись, чтобы проверить связку ключа
    let signedPreview = null;
    try {
      const msg = `tv-webhook dry-run ${p.signalId} ${Date.now()}`;
      signedPreview = await wallet.signMessage(msg);
    } catch (e) {
      console.warn("Sign preview failed:", e.message);
    }

    // Логируем без секрета
    const { secret: _omit, ...clean } = p;
    console.log("Signal accepted", {
      side: clean.side,
      chainId: clean.chainId,
      src: clean.srcToken,
      dst: clean.dstToken,
      amountMode: clean.amountMode,
      amount: clean.amountValue,
      addr: address,
      dryRun: DRY_RUN
    });

    // Ответ клиенту
    return res.json({
      ok: true,
      mode: DRY_RUN ? "dry-run" : "live",
      wallet: address,
      received: clean,
      signedPreview
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal_error" });
  }
});

// ——— Запуск ———
app.listen(PORT, () => {
  console.log(`Webhook started on port ${PORT}`);
});
