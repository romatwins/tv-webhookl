// index.js — стабильная версия с диагностикой RPC/ENV и Dry-Run/Live
import express from "express";
import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet } from "ethers";

// ---- ENV ----
const PORT = process.env.PORT || 10000;
const SHARED_SECRET   = (process.env.SHARED_SECRET || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY  || "").trim();
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

// Нормализованный доступ к RPC по трем сетям.
// Мы поддерживаем И ЛИБО RPC_URL_BASE, ИЛИ RPC_BASE, ИЛИ RPC — чтобы не промахнуться именем.
const RPCS = {
  1:      (process.env.RPC_URL_ETH  || process.env.RPC_ETH  || "").trim(),
  8453:   (process.env.RPC_URL_BASE || process.env.RPC_BASE || process.env.RPC || "").trim(),
  42161:  (process.env.RPC_URL_ARB  || process.env.RPC_ARB  || "").trim(),
};

// ---- App ----
const app = express();
app.use(bodyParser.json({ limit: "200kb", type: "application/json" }));
app.use(bodyParser.text({ limit: "200kb", type: "*/*" }));

// Универсальный парсер (TradingView иногда шлёт text/plain)
function normalizeBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    try { return JSON.parse(t); } catch { return { _raw: t }; }
  }
  return { _raw: raw };
}

// Провайдер по сети
function getProvider(chainId) {
  const url = RPCS[Number(chainId)];
  if (!url) throw new Error(`RPC not configured for chainId ${chainId}`);
  return new JsonRpcProvider(url, Number(chainId));
}

// Кошелёк из ключа (допускаем ключ без 0x)
function getWallet(provider) {
  if (!PRIVATE_KEY_RAW) throw new Error("PRIVATE_KEY is not set");
  const pk = PRIVATE_KEY_RAW.startsWith("0x") ? PRIVATE_KEY_RAW : "0x" + PRIVATE_KEY_RAW;
  return new Wallet(pk, provider);
}

// ---- Health & Debug ----
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "tv-webhook", ts: new Date().toISOString() });
});

app.get("/test", (_req, res) => {
  res.json({ ok: true, endpoint: "/test", ts: Date.now() });
});

// Покажет, какие ENV реально видит процесс (без утечки секрета/ключа)
app.get("/env", (_req, res) => {
  res.json({
    ok: true,
    DRY_RUN,
    RPCS: {
      "1": !!RPCS[1],
      "8453": !!RPCS[8453],
      "42161": !!RPCS[42161],
    },
    RPC_URL_BASE: RPCS[8453] ? (RPCS[8453].slice(0, 32) + "...") : null,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
  });
});

// Диагностика RPC + кошелька (для быстрой проверки)
app.get("/diag", async (_req, res) => {
  try {
    const provider = getProvider(8453);
    const wallet   = getWallet(provider);
    const address  = await wallet.getAddress();
    const [blockNumber, balance] = await Promise.all([
      provider.getBlockNumber(),
      provider.getBalance(address),
    ]);

    res.json({
      ok: true,
      chainId: 8453,
      blockNumber,
      wallet: address,
      balanceWei: balance.toString(),
      DRY_RUN,
      rpcBaseConfigured: !!RPCS[8453],
      HAS_SHARED_SECRET: !!SHARED_SECRET,
      HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Вернёт адрес кошелька (удобно проверить правильность PRIVATE_KEY)
app.get("/addr", async (_req, res) => {
  try {
    const provider = getProvider(8453); // используем Base для деривации
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();
    res.json({ ok: true, address, chainId: 8453 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Основной приёмник сигналов ----
app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body) || {};

    // Секрет разрешаем из заголовка и из body
    const hdrSecret = req.get("X-Secret") || req.get("x-secret") || "";
    const bodySecret = typeof body.secret === "string" ? body.secret : "";
    const provided = hdrSecret || bodySecret;

    if (!SHARED_SECRET) {
      return res.status(500).json({ ok: false, error: "server_misconfigured_no_secret" });
    }
    if (provided !== SHARED_SECRET) {
      const mask = provided ? provided.slice(0,2) + "***" + provided.slice(-2) : "";
      console.warn("Unauthorized payload", { provided: mask });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Валидация полезной нагрузки
    const p = body;
    const required = [
      "action","side","chainId",
      "srcToken","dstToken",
      "amountMode","amountValue",
      "slippageBps","deadlineSec",
      "symbol","tf","signalId"
    ];
    const missing = required.filter(k => !(k in p));
    if (missing.length) {
      console.warn("Invalid payload. Missing fields:", missing);
      return res.status(400).json({ ok: false, error: "invalid_payload", missing });
    }

    // Поднимаем провайдера/кошелёк
    const provider = getProvider(p.chainId);
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();

    // DRY-RUN: только подпишем строку, без ончейн
    if (DRY_RUN) {
      let signedPreview = null;
      try {
        const msg = `tv-webhook dry-run ${p.signalId} ${Date.now()}`;
        signedPreview = await wallet.signMessage(msg);
      } catch (e) {
        console.warn("Sign preview failed:", e.message);
      }
      const { secret: _omit, ...clean } = p;
      console.log("Signal accepted (dry-run)", {
        side: clean.side, chainId: clean.chainId,
        src: clean.srcToken, dst: clean.dstToken,
        amountMode: clean.amountMode, amount: clean.amountValue,
        addr: address, dryRun: true
      });
      return res.json({ ok: true, mode: "dry-run", wallet: address, received: clean, signedPreview });
    }

    // LIVE-режим: здесь должен быть реальный свап.
    // Пока что просто подтверждаем, что live включён.
    const { secret: _omit2, ...clean } = p;
    console.log("Signal accepted (live)", {
      side: clean.side, chainId: clean.chainId,
      src: clean.srcToken, dst: clean.dstToken,
      amountMode: clean.amountMode, amount: clean.amountValue,
      addr: address, dryRun: false
    });

    // TODO: тут подключаем реальный маршрутизатор свапа (Uniswap/0x/Aerodrome) и шлём tx
    // Для явного признака "live" вернём заглушку (без отправки txHash, пока не подключим роутер):
    return res.json({ ok: true, mode: "live", wallet: address, received: clean });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal_error" });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  // Стартовая диагностика: видно, что видит процесс
  console.log(`Webhook started on port ${PORT}`);
  console.log("ENV check:", {
    DRY_RUN,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
    RPC_ETH:   !!RPCS[1],
    RPC_BASE:  !!RPCS[8453],
    RPC_ARB:   !!RPCS[42161],
    RPC_BASE_URL: RPCS[8453] ? (RPCS[8453].slice(0, 48) + "...") : null
  });
});
