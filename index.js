// index.js — стабильная версия с диагностикой RPC/ENV и Live-свапами через 0x на Base
import express from "express";
import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet, Contract } from "ethers";

// ---- ENV ----
const PORT = process.env.PORT || 10000;
const SHARED_SECRET   = (process.env.SHARED_SECRET || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY  || "").trim();
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

// Нормализованный доступ к RPC по трём сетям
const RPCS = {
  1:      (process.env.RPC_URL_ETH  || process.env.RPC_ETH  || "").trim(),
  8453:   (process.env.RPC_URL_BASE || process.env.RPC_BASE || process.env.RPC || "").trim(),
  42161:  (process.env.RPC_URL_ARB  || process.env.RPC_ARB  || "").trim(),
};

// Адреса для проверки направлений
const TOKENS = {
  ETH_ZERO:  "0x0000000000000000000000000000000000000000",
  ETH_EEEE:  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  USDC_BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913" // USDC на Base
};

// 0x Aggregator
const ZEROX_BASE_URL = "https://base.api.0x.org";

// Минимальный ABI ERC20
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)"
];

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

// ETH-адрес?
function isEthAddress(addr) {
  const a = String(addr || "").toLowerCase();
  return (
    a === TOKENS.ETH_ZERO.toLowerCase() ||
    a === TOKENS.ETH_EEEE.toLowerCase()
  );
}

// 90% баланса ETH (native) в wei
async function getNinetyPercentEth(wallet) {
  const addr = await wallet.getAddress();
  const balance = await wallet.provider.getBalance(addr); // bigint
  const ninety = (balance * 90n) / 100n;
  if (ninety <= 0n) {
    throw new Error("Not enough ETH balance for 90% calculation");
  }
  return ninety;
}

// 90% баланса любого токена (ETH или ERC20)
async function getNinetyPercentOfToken(wallet, tokenAddress) {
  if (isEthAddress(tokenAddress)) {
    return getNinetyPercentEth(wallet);
  }
  const erc20 = new Contract(tokenAddress, ERC20_ABI, wallet);
  const addr = await wallet.getAddress();
  const balance = await erc20.balanceOf(addr); // bigint
  const ninety = (balance * 90n) / 100n;
  if (ninety <= 0n) {
    throw new Error("Not enough token balance for 90% calculation");
  }
  return ninety;
}

// Проверка и выставление allowance для ERC20 под 0x
async function ensureAllowance(wallet, tokenAddress, spender, amount) {
  const erc20 = new Contract(tokenAddress, ERC20_ABI, wallet);
  const owner = await wallet.getAddress();
  const current = await erc20.allowance(owner, spender);
  if (current >= amount) {
    return null;
  }
  const tx = await erc20.approve(spender, amount);
  const receipt = await tx.wait();
  return receipt.hash;
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
      "42161": !!RPCS[42161]
    },
    RPC_URL_BASE: RPCS[8453] ? RPCS[8453].slice(0, 32) + "..." : null,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW
  });
});

// Диагностика RPC + кошелька
app.get("/diag", async (_req, res) => {
  try {
    const provider = getProvider(8453);
    const wallet   = getWallet(provider);
    const address  = await wallet.getAddress();
    const [blockNumber, balance] = await Promise.all([
      provider.getBlockNumber(),
      provider.getBalance(address)
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
      HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Вернёт адрес кошелька
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

// ---- Основной приёмник сигналов ----
app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body) || {};

    // Секрет: из заголовка или body
    const hdrSecret = req.get("X-Secret") || req.get("x-secret") || "";
    const bodySecret = typeof body.secret === "string" ? body.secret : "";
    const provided = hdrSecret || bodySecret;

    if (!SHARED_SECRET) {
      return res.status(500).json({ ok: false, error: "server_misconfigured_no_secret" });
    }
    if (provided !== SHARED_SECRET) {
      const mask = provided ? provided.slice(0, 2) + "***" + provided.slice(-2) : "";
      console.warn("Unauthorized payload", { provided: mask });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Валидация payload’а
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

    // DRY-RUN: без ончейн
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
      return res.json({
        ok: true,
        mode: "dry-run",
        wallet: address,
        received: clean,
        signedPreview
      });
    }

    // ---------- LIVE-РЕЖИМ: реальный свап через 0x ----------
    const { secret: _omit2, ...clean } = p;

    if (Number(clean.chainId) !== 8453) {
      throw new Error(`Unsupported chainId in live mode: ${clean.chainId}`);
    }

    const src = String(clean.srcToken || "");
    const dst = String(clean.dstToken || "");

    const sellIsEth = isEthAddress(src);
    const buyIsEth  = isEthAddress(dst);

    // Разрешаем только ETH <-> USDC
    const srcIsUsdc = src.toLowerCase() === TOKENS.USDC_BASE.toLowerCase();
    const dstIsUsdc = dst.toLowerCase() === TOKENS.USDC_BASE.toLowerCase();

    if (!(
      (sellIsEth && dstIsUsdc) ||
      (srcIsUsdc && buyIsEth)
    )) {
      throw new Error("Live mode: only ETH<->USDC swaps are allowed right now");
    }

    if (clean.amountMode !== "exactIn") {
      throw new Error("Only exactIn is supported now");
    }

    // 90% баланса продаваемого токена
    const sellAmount = await getNinetyPercentOfToken(wallet, src);

    const slippageBps = Number(clean.slippageBps) || 50;
    const slippagePercentage = slippageBps / 10000; // 50 bps = 0.005

    // Для 0x ETH всегда как 0xeeee...
    const zeroXSellToken = sellIsEth ? TOKENS.ETH_EEEE : src;
    const zeroXBuyToken  = buyIsEth  ? TOKENS.ETH_EEEE : dst;

    const params = new URLSearchParams({
      sellToken: zeroXSellToken,
      buyToken: zeroXBuyToken,
      sellAmount: sellAmount.toString(),
      takerAddress: address,
      slippagePercentage: slippagePercentage.toString()
    });

    const quoteResp = await fetch(`${ZEROX_BASE_URL}/swap/v1/quote?${params.toString()}`);
    const quote = await quoteResp.json();

    if (!quoteResp.ok || !quote.to || !quote.data) {
      console.error("0x quote error:", quote);
      throw new Error("0x quote failed");
    }

    // Если продаём USDC — убедиться, что есть allowance
    let approveTxHash = null;
    if (!sellIsEth && quote.allowanceTarget) {
      approveTxHash = await ensureAllowance(wallet, src, quote.allowanceTarget, sellAmount);
    }

    const txRequest = {
      to: quote.to,
      data: quote.data,
      // ETH прокидываем value, для USDC value = 0
      value: sellIsEth ? sellAmount : 0n,
      gasLimit: quote.gas ? BigInt(quote.gas) : undefined
    };

    const tx = await wallet.sendTransaction(txRequest);
    const receipt = await tx.wait();

    console.log("LIVE swap executed", {
      txHash: tx.hash,
      status: receipt.status,
      from: address,
      side: clean.side,
      sellAmount: sellAmount.toString(),
      src,
      dst,
      approveTxHash
    });

    return res.json({
      ok: true,
      mode: "live",
      wallet: address,
      received: clean,
      sellAmountWei: sellAmount.toString(),
      txHash: tx.hash,
      approveTxHash,
      status: receipt.status
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal_error" });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Webhook started on port ${PORT}`);
  console.log("ENV check:", {
    DRY_RUN,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
    RPC_ETH:   !!RPCS[1],
    RPC_BASE:  !!RPCS[8453],
    RPC_ARB:   !!RPCS[42161],
    RPC_BASE_URL: RPCS[8453] ? RPCS[8453].slice(0, 48) + "..." : null
  });
});
