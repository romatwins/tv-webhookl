// index.js – Uniswap v3 SwapRouter02 + QuoterV2 + Multi-Fee Selection + ETH<->USDC

import express from "express";
import bodyParser from "body-parser";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  MaxUint256
} from "ethers";

// ---------- ENV ----------

const PORT = process.env.PORT || 10000;

const RPC_URL_BASE = (process.env.RPC_URL_BASE || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY || "").trim();
const SHARED_SECRET = (process.env.SHARED_SECRET || "").trim();

const PERCENT_TO_SWAP = BigInt(parseInt(process.env.PERCENT_TO_SWAP || "90", 10));
const SLIPPAGE_BPS = BigInt(parseInt(process.env.SLIPPAGE_BPS || "100", 10)); // 1%
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

const QUOTER_ADDRESS = (process.env.QUOTER_ADDRESS || "").trim();

const WALLET_WHITELIST = (process.env.WALLET_WHITELIST || "")
  .split(",").map(a => a.trim().toLowerCase()).filter(Boolean);

// ---------- CONST ----------

// Base
const CHAIN_ID_BASE = 8453;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";

// fee tiers, Uniswap v3
const FEE_TIERS = [100, 500, 3000, 10000];

// ---------- ABI ----------

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

const WETH_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function withdraw(uint256 wad)"
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256)"
];

const QUOTER_ABI = [
  "function quoteExactInputSingle(address,address,uint256,uint24,uint160) external returns (uint256,uint160,uint32,uint256)"
];

// ---------- HELPERS ----------

function provider() {
  if (!RPC_URL_BASE) throw new Error("RPC_URL_BASE missing");
  return new JsonRpcProvider(RPC_URL_BASE, CHAIN_ID_BASE);
}

function wallet(p) {
  if (!PRIVATE_KEY_RAW) throw new Error("PRIVATE_KEY missing");
  const pk = PRIVATE_KEY_RAW.startsWith("0x") ? PRIVATE_KEY_RAW : "0x" + PRIVATE_KEY_RAW;
  return new Wallet(pk, p);
}

function normalizeBody(raw) {
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  }
  return {};
}

// ---------- BALANCE 90% ----------

async function ninetyPctEth(w) {
  const bal = await w.provider.getBalance(w.address);
  if (bal === 0n) throw new Error("ETH balance zero");
  return { balance: bal, amount: (bal * PERCENT_TO_SWAP) / 100n };
}

async function ninetyPctUsdc(w, usdc) {
  const bal = await usdc.balanceOf(w.address);
  if (bal === 0n) throw new Error("USDC balance zero");
  return { balance: bal, amount: (bal * PERCENT_TO_SWAP) / 100n };
}

// ---------- MULTI-QUOTER (выбор лучшего fee-tier) ----------

async function getBestRoute(quoter, tokenIn, tokenOut, amountIn) {
  let best = null;

  for (const fee of FEE_TIERS) {
    try {
      const [amountOut] = await quoter.quoteExactInputSingle(
        tokenIn, tokenOut, amountIn, fee, 0n
      );

      if (amountOut > 0n) {
        if (!best || amountOut > best.amountOut) {
          best = { fee, amountOut };
        }
      }
    } catch (_) {}
  }

  if (!best) throw new Error("No valid pool quotes");

  const sl = (10000n - SLIPPAGE_BPS);
  const minOut = (best.amountOut * sl) / 10000n;

  if (minOut <= 0n) throw new Error("Slippage minOut zero");

  return {
    bestFee: best.fee,
    amountOut: best.amountOut,
    amountOutMinimum: minOut
  };
}

// ---------- SWAPs ----------

async function swap_USDC_to_ETH(w) {
  const p = w.provider;

  const usdc = new Contract(USDC, ERC20_ABI, w);
  const weth = new Contract(WETH, WETH_ABI, w);
  const router = new Contract(SWAP_ROUTER, ROUTER_ABI, w);
  const quoter = new Contract(QUOTER_ADDRESS, QUOTER_ABI, p);

  const { amount: amountIn, balance: usdcBal } = await ninetyPctUsdc(w, usdc);

  // allowance
  const allow = await usdc.allowance(w.address, SWAP_ROUTER);
  if (allow < amountIn) {
    const aTx = await usdc.approve(SWAP_ROUTER, MaxUint256);
    await aTx.wait();
  }

  // choose best pool
  const route = await getBestRoute(quoter, USDC, WETH, amountIn);

  const params = {
    tokenIn: USDC,
    tokenOut: WETH,
    fee: route.bestFee,
    recipient: w.address,
    deadline: Math.floor(Date.now() / 1000) + 600,
    amountIn,
    amountOutMinimum: route.amountOutMinimum,
    sqrtPriceLimitX96: 0n
  };

  if (DRY_RUN) {
    return {
      mode: "dry-run",
      direction: "USDC→ETH",
      amountIn: amountIn.toString(),
      bestFee: route.bestFee,
      quotedOut: route.amountOut.toString(),
      minOut: route.amountOutMinimum.toString(),
      usdcBalance: usdcBal.toString()
    };
  }

  const tx = await router.exactInputSingle(params, { value: 0n });
  const rc = await tx.wait();

  // unwrap WETH
  const wethBal = await weth.balanceOf(w.address);
  if (wethBal > 0n) {
    const uw = await weth.withdraw(wethBal);
    await uw.wait();
  }

  return {
    mode: "live",
    direction: "USDC→ETH",
    txHash: tx.hash,
    block: rc.blockNumber,
    amountIn: amountIn.toString(),
    minOut: route.amountOutMinimum.toString(),
    bestFee: route.bestFee
  };
}

async function swap_ETH_to_USDC(w) {
  const p = w.provider;

  const router = new Contract(SWAP_ROUTER, ROUTER_ABI, w);
  const quoter = new Contract(QUOTER_ADDRESS, QUOTER_ABI, p);

  const { amount: amountIn, balance: ethBal } = await ninetyPctEth(w);

  const route = await getBestRoute(quoter, WETH, USDC, amountIn);

  const params = {
    tokenIn: WETH,
    tokenOut: USDC,
    fee: route.bestFee,
    recipient: w.address,
    deadline: Math.floor(Date.now() / 1000) + 600,
    amountIn,
    amountOutMinimum: route.amountOutMinimum,
    sqrtPriceLimitX96: 0n
  };

  if (DRY_RUN) {
    return {
      mode: "dry-run",
      direction: "ETH→USDC",
      amountIn: amountIn.toString(),
      bestFee: route.bestFee,
      quotedOut: route.amountOut.toString(),
      minOut: route.amountOutMinimum.toString(),
      ethBalance: ethBal.toString()
    };
  }

  const tx = await router.exactInputSingle(params, { value: amountIn });
  const rc = await tx.wait();

  return {
    mode: "live",
    direction: "ETH→USDC",
    txHash: tx.hash,
    block: rc.blockNumber,
    amountIn: amountIn.toString(),
    minOut: route.amountOutMinimum.toString(),
    bestFee: route.bestFee
  };
}

// ---------- APP ----------

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.text());

app.get("/", (_r, res) => res.json({ ok: true, service: "tv-webhookl" }));

app.get("/diag", async (_req, res) => {
  try {
    const p = provider();
    const w = wallet(p);
    const bal = await p.getBalance(w.address);

    res.json({
      ok: true,
      address: w.address,
      balanceWei: bal.toString(),
      DRY_RUN,
      whitelisted: WALLET_WHITELIST.length === 0 ||
                   WALLET_WHITELIST.includes(w.address.toLowerCase()),
      hasQuoter: !!QUOTER_ADDRESS
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// RECEIVE TRADINGVIEW
app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body);
    const sec = req.get("X-Secret") || body.secret;

    if (sec !== SHARED_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });

    const p = provider();
    const w = wallet(p);

    if (WALLET_WHITELIST.length > 0 &&
        !WALLET_WHITELIST.includes(w.address.toLowerCase())) {
      throw new Error("Wallet not whitelisted");
    }

    const side = String(body.side).toUpperCase();

    let result;
    if (side === "BUY") {
      result = await swap_USDC_to_ETH(w);
    } else if (side === "SELL") {
      result = await swap_ETH_to_USDC(w);
    } else {
      throw new Error(`Unknown side: ${side}`);
    }

    res.json({ ok: true, ...result });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- START ----------

app.listen(PORT, () => {
  console.log("tv-webhookl started on port", PORT);
});
