// index.js: боевой ETH -> USDC через 0x на Base + диагностика и whitelist

import express from "express";
import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import fetch from "node-fetch";

// ==== ENV ====
const PORT = process.env.PORT || 10000;

const SHARED_SECRET   = (process.env.SHARED_SECRET || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY  || "").trim();
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

const RPCS = {
  1:      (process.env.RPC_URL_ETH  || process.env.RPC_ETH  || "").trim(),
  8453:   (process.env.RPC_URL_BASE || process.env.RPC_BASE || process.env.RPC || "").trim(),
  42161:  (process.env.RPC_URL_ARB  || process.env.RPC_ARB  || "").trim(),
};

// Белый список кошельков и роутеров, через которые разрешено проводить сделки
const WALLET_WHITELIST = (process.env.WALLET_WHITELIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const ROUTER_WHITELIST = (process.env.ROUTER_WHITELIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ==== Константы по Base ETH/USDC ====
const TOKENS = {
  ETH_ZERO:  "0x0000000000000000000000000000000000000000",
  ETH_EEEE:  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  USDC_BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913"
};

const ZEROX_BASE_URL = "https://base.api.0x.org";

// Минимальный ABI для ERC20, если потом будем трогать USDC
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ==== App ====
const app = express();
app.use(bodyParser.json({ limit: "200kb", type: "application/json" }));
app.use(bodyParser.text({ limit: "200kb", type: "*/*" }));

// Универсальный парсер TradingView
function normalizeBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    try { return JSON.parse(t); } catch { return { _raw: t }; }
  }
  return { _raw: raw };
}

// Провайдер
function getProvider(chainId) {
  const url = RPCS[Number(chainId)];
  if (!url) throw new Error(`RPC not configured for chainId ${chainId}`);
  return new JsonRpcProvider(url, Number(chainId));
}

// Кошелек
function getWallet(provider) {
  if (!PRIVATE_KEY_RAW) throw new Error("PRIVATE_KEY is not set");
  const pk = PRIVATE_KEY_RAW.startsWith("0x") ? PRIVATE_KEY_RAW : "0x" + PRIVATE_KEY_RAW;
  return new Wallet(pk, provider);
}

// 90% баланса ETH
async function getNinetyPercentEth(wallet) {
  const addr = await wallet.getAddress();
  const balance = await wallet.provider.getBalance(addr); // bigint
  const ninety = balance * 90n / 100n;
  if (ninety <= 0n) {
    throw new Error("Not enough ETH balance for 90% calculation");
  }
  return ninety;
}

// Проверка, что адрес похож на ETH-алиас
function isEthLike(addr) {
  const a = String(addr || "").toLowerCase();
  return a === TOKENS.ETH_ZERO.toLowerCase()
    || a === TOKENS.ETH_EEEE.toLowerCase();
}

// ==== Health ====
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "tv-webhook", ts: new Date().toISOString() });
});

app.get("/test", (_req, res) => {
  res.json({ ok: true, endpoint: "/test", ts: Date.now() });
});

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
    WALLET_WHITELIST_SIZE: WALLET_WHITELIST.length,
    ROUTER_WHITELIST_SIZE: ROUTER_WHITELIST.length
  });
});

app.get("/diag", async (_req, res) => {
  try {
    const provider = getProvider(8453);
    const wallet   = getWallet(provider);
    const address  = await wallet.getAddress();
    const [blockNumber, balance] = await Promise.all([
      provider.getBlockNumber(),
      provider.getBalance(address),
    ]);

    const whitelisted =
      WALLET_WHITELIST.length === 0 ||
      WALLET_WHITELIST.includes(address.toLowerCase());

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
      walletWhitelisted: whitelisted
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/addr", async (_req, res) => {
  try {
    const provider = getProvider(8453);
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();
    res.json({ ok: true, address, chainId: 8453 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==== Основной приёмник сигналов ====
app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body) || {};

    // Авторизация по секрету
    const hdrSecret  = req.get("X-Secret") || req.get("x-secret") || "";
    const bodySecret = typeof body.secret === "string" ? body.secret : "";
    const provided   = hdrSecret || bodySecret;

    if (!SHARED_SECRET) {
      return res.status(500).json({ ok: false, error: "server_misconfigured_no_secret" });
    }
    if (provided !== SHARED_SECRET) {
      const mask = provided ? provided.slice(0,2) + "***" + provided.slice(-2) : "";
      console.warn("Unauthorized payload", { provided: mask });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Валидация полей
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

    if (String(p.amountMode) !== "exactIn") {
      return res.status(400).json({ ok: false, error: "Only exactIn is supported now" });
    }

    // Поднимаем провайдер и кошелек
    const provider = getProvider(p.chainId);
    const wallet   = getWallet(provider);
    const address  = await wallet.getAddress();

    if (
      WALLET_WHITELIST.length > 0 &&
      !WALLET_WHITELIST.includes(address.toLowerCase())
    ) {
      throw new Error("Wallet address is not in WALLET_WHITELIST");
    }

    // DRY_RUN: только подпись, без сети
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
        side: clean.side,
        chainId: clean.chainId,
        src: clean.srcToken,
        dst: clean.dstToken,
        amountMode: clean.amountMode,
        amount: clean.amountValue,
        addr: address,
        dryRun: true
      });
      return res.json({
        ok: true,
        mode: "dry-run",
        wallet: address,
        received: clean,
        signedPreview
      });
    }

    // ==== LIVE режим, только ETH -> USDC на Base через 0x ====
    if (Number(p.chainId) !== 8453) {
      throw new Error(`Only Base chainId 8453 is supported in live mode`);
    }

    const srcLower = String(p.srcToken || "").toLowerCase();
    const dstLower = String(p.dstToken || "").toLowerCase();

    const srcIsEth   = isEthLike(srcLower);
    const dstIsEth   = isEthLike(dstLower);
    const srcIsUsdc  = srcLower === TOKENS.USDC_BASE.toLowerCase();
    const dstIsUsdc  = dstLower === TOKENS.USDC_BASE.toLowerCase();

    // Разрешаем только ETH -> USDC
    if (!(srcIsEth && dstIsUsdc)) {
      throw new Error("Live mode: only ETH -> USDC swaps are enabled right now");
    }

    const sellAmountWei = await getNinetyPercentEth(wallet);
    const slippageBps = Number(p.slippageBps || 50);
    const slippagePct = slippageBps / 10_000; // 50 bps = 0.005

    // Берем котировку 0x
    const qs = new URLSearchParams({
      buyToken: TOKENS.USDC_BASE,
      sellToken: TOKENS.ETH_EEEE,
      sellAmount: sellAmountWei.toString(),
      takerAddress: address,
      slippagePercentage: slippagePct.toString()
    });

    const quoteUrl = `${ZEROX_BASE_URL}/swap/v1/quote?${qs.toString()}`;
    const quoteResp = await fetch(quoteUrl);

    if (!quoteResp.ok) {
      const txt = await quoteResp.text();
      console.error("0x quote failed", { status: quoteResp.status, body: txt });
      return res.status(500).json({
        ok: false,
        error: "0x_quote_failed",
        status: quoteResp.status
      });
    }

    const quote = await quoteResp.json();

    // Адрес роутера из котировки
    const routerAddress = String(quote.to || "").toLowerCase();

    if (ROUTER_WHITELIST.length > 0 &&
        !ROUTER_WHITELIST.includes(routerAddress)) {
      console.error("Router not in whitelist", { routerAddress });
      throw new Error("Router address not in ROUTER_WHITELIST");
    }

    console.log("0x quote received", {
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      router: routerAddress,
      price: quote.price
    });

    // Готовим транзакцию только на роутер 0x, никаких прямых переводов
    const txRequest = {
      to: quote.to,
      data: quote.data,
      value: quote.value ? BigInt(quote.value) : 0n
      // Газ дадим посчитать провайдеру, чтобы не ловить BigInt/JSON ошибки
    };

    const tx = await wallet.sendTransaction(txRequest);

    console.log("LIVE SWAP SENT", {
      txHash: tx.hash,
      from: address,
      to: routerAddress,
      sellAmountWei: sellAmountWei.toString()
    });

    const { secret: _omit2, ...clean } = p;

    return res.json({
      ok: true,
      mode: "live-sent",
      wallet: address,
      txHash: tx.hash,
      router: routerAddress,
      received: clean,
      plannedSellAmountWei: sellAmountWei.toString(),
      quote: {
        sellAmount: quote.sellAmount,
        buyAmount: quote.buyAmount,
        price: quote.price
      }
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal_error" });
  }
});

// ==== Start ====
app.listen(PORT, () => {
  console.log(`tv-webhookl started on port ${PORT}`);
  console.log("ENV check:", {
    DRY_RUN,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
    RPC_ETH:   !!RPCS[1],
    RPC_BASE:  !!RPCS[8453],
    RPC_ARB:   !!RPCS[42161],
    RPC_BASE_URL: RPCS[8453] ? (RPCS[8453].slice(0, 48) + "...") : null,
    WALLET_WHITELIST_SIZE: WALLET_WHITELIST.length,
    ROUTER_WHITELIST_SIZE: ROUTER_WHITELIST.length
  });
});
