// index.js – Uniswap v3 SwapRouter02 на Base, USDC<->ETH, 90% баланса, QuoterV2

import express from "express";
import bodyParser from "body-parser";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  Interface,
  MaxUint256,
  formatUnits
} from "ethers";

// ========== ENV ==========

const PORT = process.env.PORT || 10000;

const RPC_URL_BASE = (process.env.RPC_URL_BASE || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY || "").trim();
const SHARED_SECRET = (process.env.SHARED_SECRET || "").trim();

const PERCENT_TO_SWAP = BigInt(parseInt(process.env.PERCENT_TO_SWAP || "90", 10)); // 90 = 90%
const SLIPPAGE_BPS = BigInt(parseInt(process.env.SLIPPAGE_BPS || "100", 10));     // 100 = 1%
const POOL_FEE = parseInt(process.env.POOL_FEE || "500", 10);                     // 500 = 0.05%

const QUOTER_ADDRESS = (process.env.QUOTER_ADDRESS || "").trim();

const WALLET_WHITELIST = (process.env.WALLET_WHITELIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

// ========== СЕТЬ / АДРЕСА ==========

// Base mainnet
const CHAIN_ID_BASE = 8453;

// Официальные адреса на Base
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER_ADDRESS = "0x2626664c2603336E57B271c5C0b26F421741e481";

// ========== ABI ==========

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)"
];

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

const WETH_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function withdraw(uint256 wad) public"
];

// QuoterV2 – минимальный ABI
const QUOTER_ABI = [
  "function quoteExactInputSingle(" +
    "address tokenIn," +
    "address tokenOut," +
    "uint256 amountIn," +
    "uint24 fee," +
    "uint160 sqrtPriceLimitX96" +
  ") external returns (" +
    "uint256 amountOut," +
    "uint160 sqrtPriceX96After," +
    "uint32 initializedTicksCrossed," +
    "uint256 gasEstimate" +
  ")"
];

// ========== ИНИЦИАЛИЗАЦИЯ ==========

function getProvider() {
  if (!RPC_URL_BASE) {
    throw new Error("RPC_URL_BASE is not set");
  }
  return new JsonRpcProvider(RPC_URL_BASE, CHAIN_ID_BASE);
}

function getWallet(provider) {
  if (!PRIVATE_KEY_RAW) throw new Error("PRIVATE_KEY is not set");
  const pk = PRIVATE_KEY_RAW.startsWith("0x") ? PRIVATE_KEY_RAW : "0x" + PRIVATE_KEY_RAW;
  return new Wallet(pk, provider);
}

function normalizeBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    try { return JSON.parse(t); } catch { return { _raw: t }; }
  }
  return { _raw: raw };
}

// ========== ЛОГИКА 90% БАЛАНСА ==========

async function getNinetyPercentUsdc(wallet, usdc) {
  const bal = await usdc.balanceOf(wallet.address); // bigint
  if (bal === 0n) throw new Error("USDC balance is zero");
  const amount = (bal * PERCENT_TO_SWAP) / 100n;
  if (amount <= 0n) throw new Error("USDC amount to swap is zero");
  return { balance: bal, amount };
}

async function getNinetyPercentEth(wallet) {
  const bal = await wallet.provider.getBalance(wallet.address); // bigint
  if (bal === 0n) throw new Error("ETH balance is zero");
  const amount = (bal * PERCENT_TO_SWAP) / 100n;
  if (amount <= 0n) throw new Error("ETH amount to swap is zero");
  return { balance: bal, amount };
}

// ========== QUOTER: расчёт amountOutMinimum ==========

async function quoteOutMin(quoter, tokenIn, tokenOut, amountIn) {
  if (!QUOTER_ADDRESS) {
    throw new Error("QUOTER_ADDRESS is not set");
  }
  if (amountIn <= 0n) throw new Error("AmountIn must be > 0");

  const [amountOut] = await quoter.quoteExactInputSingle(
    tokenIn,
    tokenOut,
    amountIn,
    POOL_FEE,
    0n // без лимита по цене
  );

  if (amountOut === 0n) {
    throw new Error("Quoter returned zero amountOut");
  }

  const slippageFactor = 10000n - SLIPPAGE_BPS; // например 9900 при 1%
  const minOut = (amountOut * slippageFactor) / 10000n;

  if (minOut <= 0n) {
    throw new Error("Computed amountOutMinimum is zero");
  }

  return { amountOut, amountOutMinimum: minOut };
}

// ========== СВOПЫ ==========

// USDC -> ETH (через USDC -> WETH -> withdraw)
async function swapUsdcToEth(wallet) {
  const provider = wallet.provider;

  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const weth = new Contract(WETH_ADDRESS, WETH_ABI, wallet);
  const router = new Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
  const quoter = new Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);

  const usdcDecimals = await usdc.decimals();

  const { balance: usdcBalance, amount: amountIn } = await getNinetyPercentUsdc(wallet, usdc);

  const allowance = await usdc.allowance(wallet.address, SWAP_ROUTER_ADDRESS);
  if (allowance < amountIn) {
    const approveTx = await usdc.approve(SWAP_ROUTER_ADDRESS, MaxUint256);
    await approveTx.wait();
  }

  const { amountOut, amountOutMinimum } = await quoteOutMin(
    quoter,
    USDC_ADDRESS,
    WETH_ADDRESS,
    amountIn
  );

  const deadline = Math.floor(Date.now() / 1000) + 600;

  const params = {
    tokenIn: USDC_ADDRESS,
    tokenOut: WETH_ADDRESS,
    fee: POOL_FEE,
    recipient: wallet.address,
    deadline,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96: 0n
  };

  if (DRY_RUN) {
    return {
      mode: "dry-run",
      direction: "USDC_TO_ETH",
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      usdcBalance: usdcBalance.toString()
    };
  }

  const tx = await router.exactInputSingle(params, { value: 0n });
  const receipt = await tx.wait();

  const wethBalance = await weth.balanceOf(wallet.address);
  if (wethBalance > 0n) {
    const unwrapTx = await weth.withdraw(wethBalance);
    await unwrapTx.wait();
  }

  return {
    mode: "live",
    direction: "USDC_TO_ETH",
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    amountIn: amountIn.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    quotedAmountOut: amountOut.toString(),
    usdcBalanceBefore: usdcBalance.toString(),
    wethUnwrapped: wethBalance.toString()
  };
}

// ETH -> USDC (ETH -> WETH -> USDC, Router сам оборачивает ETH)
async function swapEthToUsdc(wallet) {
  const provider = wallet.provider;

  const router = new Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
  const quoter = new Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);

  const { balance: ethBalance, amount: amountIn } = await getNinetyPercentEth(wallet);

  const { amountOut, amountOutMinimum } = await quoteOutMin(
    quoter,
    WETH_ADDRESS,
    USDC_ADDRESS,
    amountIn
  );

  const deadline = Math.floor(Date.now() / 1000) + 600;

  const params = {
    tokenIn: WETH_ADDRESS,
    tokenOut: USDC_ADDRESS,
    fee: POOL_FEE,
    recipient: wallet.address,
    deadline,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96: 0n
  };

  if (DRY_RUN) {
    return {
      mode: "dry-run",
      direction: "ETH_TO_USDC",
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      ethBalance: ethBalance.toString()
    };
  }

  const tx = await router.exactInputSingle(params, { value: amountIn });
  const receipt = await tx.wait();

  return {
    mode: "live",
    direction: "ETH_TO_USDC",
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    amountIn: amountIn.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    quotedAmountOut: amountOut.toString(),
    ethBalanceBefore: ethBalance.toString()
  };
}

// ========== EXPRESS APP ==========

const app = express();
app.use(bodyParser.json({ limit: "200kb", type: "application/json" }));
app.use(bodyParser.text({ limit: "200kb", type: "*/*" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "tv-webhookl", ts: new Date().toISOString() });
});

app.get("/env", (_req, res) => {
  res.json({
    ok: true,
    DRY_RUN,
    RPC_URL_BASE: RPC_URL_BASE ? RPC_URL_BASE.slice(0, 32) + "..." : null,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
    PERCENT_TO_SWAP: PERCENT_TO_SWAP.toString(),
    SLIPPAGE_BPS: SLIPPAGE_BPS.toString(),
    POOL_FEE,
    HAS_QUOTER: !!QUOTER_ADDRESS,
    WALLET_WHITELIST_SIZE: WALLET_WHITELIST.length
  });
});

app.get("/diag", async (_req, res) => {
  try {
    const provider = getProvider();
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();
    const [blockNumber, balance] = await Promise.all([
      provider.getBlockNumber(),
      provider.getBalance(address)
    ]);

    const whitelisted =
      WALLET_WHITELIST.length === 0 ||
      WALLET_WHITELIST.includes(address.toLowerCase());

    res.json({
      ok: true,
      chainId: CHAIN_ID_BASE,
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

// Основной приёмник сигналов с TradingView
app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body) || {};

    // Проверка секрета
    const hdrSecret = req.get("X-Secret") || req.get("x-secret") || "";
    const bodySecret = typeof body.secret === "string" ? body.secret : "";
    const provided = hdrSecret || bodySecret;

    if (!SHARED_SECRET) {
      return res.status(500).json({ ok: false, error: "server_misconfigured_no_secret" });
    }
    if (provided !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const p = body;

    // chainId должен быть Base
    if (Number(p.chainId) !== CHAIN_ID_BASE) {
      throw new Error(`Unsupported chainId: ${p.chainId}, only 8453 is allowed`);
    }

    const provider = getProvider();
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();

    if (
      WALLET_WHITELIST.length > 0 &&
      !WALLET_WHITELIST.includes(address.toLowerCase())
    ) {
      throw new Error("Wallet address is not in WALLET_WHITELIST");
    }

    const side = String(p.side || "").toUpperCase();

    let result;
    if (side === "BUY") {
      // USDC -> ETH
      result = await swapUsdcToEth(wallet);
    } else if (side === "SELL") {
      // ETH -> USDC
      result = await swapEthToUsdc(wallet);
    } else {
      throw new Error(`Unknown side: ${p.side}`);
    }

    return res.json({
      ok: true,
      receivedSide: side,
      wallet: address,
      ...result
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal_error" });
  }
});

// ========== START ==========

app.listen(PORT, () => {
  console.log(`tv-webhookl started on port ${PORT}`);
  console.log("ENV check:", {
    DRY_RUN,
    RPC_URL_BASE: RPC_URL_BASE ? RPC_URL_BASE.slice(0, 48) + "..." : null,
    HAS_SHARED_SECRET: !!SHARED_SECRET,
    HAS_PRIVATE_KEY: !!PRIVATE_KEY_RAW,
    HAS_QUOTER: !!QUOTER_ADDRESS,
    PERCENT_TO_SWAP: PERCENT_TO_SWAP.toString(),
    SLIPPAGE_BPS: SLIPPAGE_BPS.toString(),
    POOL_FEE,
    WALLET_WHITELIST_SIZE: WALLET_WHITELIST.length
  });
});
