// index.js — TradingView webhookl → Uniswap v3 SwapRouter02 (Base)
// BUY  = USDC -> ETH (через WETH)
// SELL = ETH  -> USDC (через WETH)
// Модель: PERCENT_TO_SWAP% от баланса, slippage через Quoter (если задан)

import express from "express";
import bodyParser from "body-parser";
import { ethers } from "ethers";

// ========= ENV =========

const PORT = process.env.PORT || 10000;

// Base RPC
const RPC_URL_BASE = (process.env.RPC_URL_BASE || process.env.RPC_BASE || process.env.RPC || "").trim();

// Секрет и приватный ключ
const SHARED_SECRET   = (process.env.SHARED_SECRET || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY  || "").trim();

// DRY_RUN: true  → ничего не шлём в сеть, только считаем
//          false → отправляем реальные транзакции
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

// Процент от баланса (поддерживаю и старую опечатку)
const PERCENT_TO_SWAP = Number(
  process.env.PERCENT_TO_SWAP ||
  process.env.PERCENT_TO_SWA ||
  "90"
);

// Комиссия пула USDC/WETH (по умолчанию 0.05% = 500)
const POOL_FEE = Number(process.env.POOL_FEE || "500");

// Slippage в bps (по умолчанию 1% = 100 bps)
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || "100");

// Белый список кошельков (адреса через запятую, в lower-case)
const WALLET_WHITELIST = (process.env.WALLET_WHITELIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Адрес Quoter (V2) — ОБЯЗАТЕЛЬНО поставь из официальных доков, если хочешь нормальный slippage
// Если оставить пустым, amountOutMinimum будет 0 (это риск, но безопаснее, чем выдуманный адрес).
const QUOTER_ADDRESS = (process.env.QUOTER_ADDRESS || "").trim();

// ========= Адреса контрактов Base =========

// Официальные адреса Uniswap v3 на Base (из docs)
const ROUTER_ADDRESS = "0x2626664c2603336E57B271c5C0b26F421741e481"; // SwapRouter02

// Токены
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC (native Base)
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // WETH (Base)

// ETH псевдо-адреса (как раньше)
const ETH_ZERO = "0x0000000000000000000000000000000000000000";
const ETH_EEEE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// ========= ABI =========

// ERC20
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

// SwapRouter02: exactInputSingle
const SWAP_ROUTER_ABI = [
  "function exactInputSingle(tuple(" +
    "address tokenIn," +
    "address tokenOut," +
    "uint24 fee," +
    "address recipient," +
    "uint256 deadline," +
    "uint256 amountIn," +
    "uint256 amountOutMinimum," +
    "uint160 sqrtPriceLimitX96" +
  ") params) external payable returns (uint256 amountOut)"
];

// WETH (ERC20 + wrap/unwrap)
const WETH_ABI = [
  "function deposit() public payable",
  "function withdraw(uint256 wad) public",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// Quoter / QuoterV2 (минимальный интерфейс)
// На многих сетях сигнатура такая:
const QUOTER_ABI = [
  "function quoteExactInputSingle(" +
    "address tokenIn," +
    "address tokenOut," +
    "uint24 fee," +
    "uint256 amountIn," +
    "uint160 sqrtPriceLimitX96" +
  ") external returns (uint256 amountOut)"
];

// ========= Вспомогательные функции =========

function getProvider() {
  if (!RPC_URL_BASE) {
    throw new Error("RPC_URL_BASE is not configured");
  }
  return new ethers.JsonRpcProvider(RPC_URL_BASE, 8453);
}

function getWallet(provider) {
  if (!PRIVATE_KEY_RAW) {
    throw new Error("PRIVATE_KEY is not set");
  }
  const pk = PRIVATE_KEY_RAW.startsWith("0x")
    ? PRIVATE_KEY_RAW
    : "0x" + PRIVATE_KEY_RAW;
  return new ethers.Wallet(pk, provider);
}

function isEthLike(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase();
  return a === ETH_ZERO.toLowerCase() || a === ETH_EEEE.toLowerCase();
}

// Процент от баланса (в bigint)
function applyPercent(amountBigInt) {
  const pct = Number.isFinite(PERCENT_TO_SWAP) && PERCENT_TO_SWAP > 0 && PERCENT_TO_SWAP <= 100
    ? PERCENT_TO_SWAP
    : 90;
  return (amountBigInt * BigInt(pct)) / 100n;
}

// Считаем минимум по slippage: amountOutMin = quote * (1 - slippage)
function applySlippage(amountOut) {
  const bps = Number.isFinite(SLIPPAGE_BPS) && SLIPPAGE_BPS >= 0 ? SLIPPAGE_BPS : 100;
  const numerator = 10_000n - BigInt(bps);
  return (amountOut * numerator) / 10_000n;
}

// ========= Express app =========

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

// ---- Health endpoints ----

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "tv-webhookl", ts: new Date().toISOString() });
});

app.get("/env", (_req, res) => {
  res.json({
    ok: true,
    DRY_RUN,
    RPC_URL_BASE: RPC_URL_BASE ? RPC_URL_BASE.slice(0, 40) + "..." : null,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
    PERCENT_TO_SWAP,
    POOL_FEE,
    SLIPPAGE_BPS,
    WALLET_WHITELIST_SIZE: WALLET_WHITELIST.length,
    HAS_QUOTER: !!QUOTER_ADDRESS
  });
});

app.get("/diag", async (_req, res) => {
  try {
    const provider = getProvider();
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();
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
      rpcBaseConfigured: !!RPC_URL_BASE,
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
    const provider = getProvider();
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();
    res.json({ ok: true, address, chainId: 8453 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ========= Основной приёмник сигналов TradingView =========

app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body) || {};

    // --- Авторизация по SHARED_SECRET ---
    const hdrSecret  = req.get("X-Secret") || req.get("x-secret") || "";
    const bodySecret = typeof body.secret === "string" ? body.secret : "";
    const provided   = hdrSecret || bodySecret;

    if (!SHARED_SECRET) {
      return res.status(500).json({ ok: false, error: "server_misconfigured_no_secret" });
    }
    if (provided !== SHARED_SECRET) {
      const mask = provided ? provided.slice(0, 2) + "***" + provided.slice(-2) : "";
      console.warn("Unauthorized payload", { provided: mask });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // --- Валидация полей TradingView ---
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
      return res.status(400).json({ ok: false, error: "Only amountMode=exactIn is supported" });
    }

    const chainId = Number(p.chainId);
    if (chainId !== 8453) {
      return res.status(400).json({ ok: false, error: "Only Base chainId=8453 is supported" });
    }

    const side = String(p.side || "").toUpperCase(); // BUY / SELL
    const srcLower = String(p.srcToken || "").toLowerCase();
    const dstLower = String(p.dstToken || "").toLowerCase();

    const usdcLower = USDC_ADDRESS.toLowerCase();
    const wethLower = WETH_ADDRESS.toLowerCase();

    // Проверяем, что TradingView не прислал сюрпризов
    if (side === "BUY") {
      // Должно быть: src = USDC, dst = ETH
      if (!(srcLower === usdcLower && isEthLike(dstLower))) {
        return res.status(400).json({
          ok: false,
          error: "For BUY expected srcToken=USDC, dstToken=ETH-like"
        });
      }
    } else if (side === "SELL") {
      // Должно быть: src = ETH, dst = USDC
      if (!(isEthLike(srcLower) && dstLower === usdcLower)) {
        return res.status(400).json({
          ok: false,
          error: "For SELL expected srcToken=ETH-like, dstToken=USDC"
        });
      }
    } else {
      return res.status(400).json({ ok: false, error: "side must be BUY or SELL" });
    }

    // --- Поднимаем провайдер и кошелёк ---
    const provider = getProvider();
    const wallet   = getWallet(provider);
    const address  = await wallet.getAddress();

    if (
      WALLET_WHITELIST.length > 0 &&
      !WALLET_WHITELIST.includes(address.toLowerCase())
    ) {
      throw new Error("Wallet address is not in WALLET_WHITELIST");
    }

    const usdc  = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const weth  = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);
    const router = new ethers.Contract(ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
    const quoter = QUOTER_ADDRESS
      ? new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider)
      : null;

    // === DRY RUN ===
    if (DRY_RUN) {
      const preview = {};

      if (side === "BUY") {
        const usdcBalance = await usdc.balanceOf(address);
        const usdcDecimals = await usdc.decimals();
        const amountIn = applyPercent(usdcBalance);

        preview.direction = "USDC_TO_ETH";
        preview.usdcBalance = usdcBalance.toString();
        preview.amountIn = amountIn.toString();
        preview.amountInHuman = ethers.formatUnits(amountIn, usdcDecimals);

        if (quoter) {
          try {
            const quoteOut = await quoter.quoteExactInputSingle.staticCall(
              USDC_ADDRESS,
              WETH_ADDRESS,
              POOL_FEE,
              amountIn,
              0
            );
            const minOut = applySlippage(quoteOut);
            preview.quoteOut = quoteOut.toString();
            preview.amountOutMinimum = minOut.toString();
          } catch (e) {
            preview.quoterError = e.message;
          }
        }
      } else {
        const ethBalance = await provider.getBalance(address);
        const amountIn = applyPercent(ethBalance);

        preview.direction = "ETH_TO_USDC";
        preview.ethBalanceWei = ethBalance.toString();
        preview.amountInWei = amountIn.toString();
        preview.amountInETH = ethers.formatEther(amountIn);

        if (quoter) {
          try {
            const quoteOut = await quoter.quoteExactInputSingle.staticCall(
              WETH_ADDRESS,
              USDC_ADDRESS,
              POOL_FEE,
              amountIn,
              0
            );
            const minOut = applySlippage(quoteOut);
            preview.quoteOut = quoteOut.toString();
            preview.amountOutMinimum = minOut.toString();
          } catch (e) {
            preview.quoterError = e.message;
          }
        }
      }

      const { secret: _omit, ...clean } = p;
      console.log("Signal accepted (dry-run)", {
        side,
        symbol: p.symbol,
        addr: address,
        direction: preview.direction
      });

      return res.json({
        ok: true,
        mode: "dry-run",
        wallet: address,
        side,
        preview,
        received: clean
      });
    }

    // === LIVE: реальные свопы через Uniswap v3 ===

    let txHash = null;
    let swapInfo = {};

    if (side === "BUY") {
      // ---------- USDC -> ETH ----------
      const usdcBalance = await usdc.balanceOf(address);
      const usdcDecimals = await usdc.decimals();
      const amountIn = applyPercent(usdcBalance);

      if (amountIn <= 0n) {
        throw new Error("USDC balance too small for BUY");
      }

      // 1. allowance USDC -> Router
      const allowance = await usdc.allowance(address, ROUTER_ADDRESS);
      if (allowance < amountIn) {
        console.log("Approving USDC for router...");
        const approveTx = await usdc.approve(ROUTER_ADDRESS, ethers.MaxUint256);
        await approveTx.wait();
        console.log("Approve confirmed:", approveTx.hash);
      }

      // 2. Quoter (если есть)
      let amountOutMinimum = 0n;
      if (quoter) {
        try {
          const quoteOut = await quoter.quoteExactInputSingle.staticCall(
            USDC_ADDRESS,
            WETH_ADDRESS,
            POOL_FEE,
            amountIn,
            0
          );
          amountOutMinimum = applySlippage(quoteOut);
        } catch (e) {
          console.error("Quoter BUY failed, fallback to minOut=0:", e.message);
        }
      }

      const deadline = Math.floor(Date.now() / 1000) + Number(p.deadlineSec || 600);

      const params = {
        tokenIn: USDC_ADDRESS,
        tokenOut: WETH_ADDRESS,
        fee: POOL_FEE,
        recipient: address,
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n
      };

      console.log("Sending USDC->WETH swap via router...");
      const tx = await router.exactInputSingle(params, { value: 0n });
      txHash = tx.hash;

      console.log("Swap sent:", txHash);
      const receipt = await tx.wait();
      console.log("Swap confirmed in block", receipt.blockNumber);

      // 3. Unwrap WETH -> ETH (весь баланс WETH)
      const wethBalance = await weth.balanceOf(address);
      if (wethBalance > 0n) {
        console.log("Unwrapping WETH to ETH:", ethers.formatEther(wethBalance));
        const unwrapTx = await weth.withdraw(wethBalance);
        await unwrapTx.wait();
        console.log("Unwrap confirmed:", unwrapTx.hash);
      }

      swapInfo = {
        direction: "USDC_TO_ETH",
        amountIn: amountIn.toString(),
        amountInHuman: ethers.formatUnits(amountIn, usdcDecimals),
        amountOutMinimum: amountOutMinimum.toString()
      };
    } else {
      // ---------- ETH -> USDC ----------
      const ethBalance = await provider.getBalance(address);
      const amountIn = applyPercent(ethBalance);

      if (amountIn <= 0n) {
        throw new Error("ETH balance too small for SELL");
      }

      // 1. Wrap ETH -> WETH
      console.log("Wrapping ETH to WETH:", ethers.formatEther(amountIn));
      const wrapTx = await weth.deposit({ value: amountIn });
      await wrapTx.wait();
      console.log("Wrap confirmed:", wrapTx.hash);

      // 2. allowance WETH -> Router
      const wethAllowance = await weth.allowance(address, ROUTER_ADDRESS);
      if (wethAllowance < amountIn) {
        console.log("Approving WETH for router...");
        const approveTx = await weth.approve(ROUTER_ADDRESS, ethers.MaxUint256);
        await approveTx.wait();
        console.log("Approve confirmed:", approveTx.hash);
      }

      // 3. Quoter (если есть)
      let amountOutMinimum = 0n;
      if (quoter) {
        try {
          const quoteOut = await quoter.quoteExactInputSingle.staticCall(
            WETH_ADDRESS,
            USDC_ADDRESS,
            POOL_FEE,
            amountIn,
            0
          );
          amountOutMinimum = applySlippage(quoteOut);
        } catch (e) {
          console.error("Quoter SELL failed, fallback to minOut=0:", e.message);
        }
      }

      const deadline = Math.floor(Date.now() / 1000) + Number(p.deadlineSec || 600);

      const params = {
        tokenIn: WETH_ADDRESS,
        tokenOut: USDC_ADDRESS,
        fee: POOL_FEE,
        recipient: address,
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n
      };

      console.log("Sending WETH->USDC swap via router...");
      const tx = await router.exactInputSingle(params, { value: 0n });
      txHash = tx.hash;

      console.log("Swap sent:", txHash);
      const receipt = await tx.wait();
      console.log("Swap confirmed in block", receipt.blockNumber);

      swapInfo = {
        direction: "ETH_TO_USDC",
        amountInWei: amountIn.toString(),
        amountInETH: ethers.formatEther(amountIn),
        amountOutMinimum: amountOutMinimum.toString()
      };
    }

    const { secret: _omit2, ...clean } = p;

    return res.json({
      ok: true,
      mode: "live-sent",
      wallet: address,
      side,
      txHash,
      swap: swapInfo,
      received: clean
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal_error" });
  }
});

// ========= Start =========

app.listen(PORT, () => {
  console.log(`tv-webhookl started on port ${PORT}`);
  console.log("ENV check:", {
    DRY_RUN,
    RPC_URL_BASE: RPC_URL_BASE ? RPC_URL_BASE.slice(0, 60) + "..." : null,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
    PERCENT_TO_SWAP,
    POOL_FEE,
    SLIPPAGE_BPS,
    WALLET_WHITELIST_SIZE: WALLET_WHITELIST.length,
    HAS_QUOTER: !!QUOTER_ADDRESS
  });
});
