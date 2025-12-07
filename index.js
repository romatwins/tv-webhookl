// index.js — рабочий вариант Uniswap v3 swap для Base
// 90% USDC <-> WETH, корректный ABI, корректные tuple-параметры

import express from "express";
import bodyParser from "body-parser";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  MaxUint256,
  formatUnits
} from "ethers";

// ========== ENV ==========

const PORT = process.env.PORT || 10000;

const RPC_URL_BASE    = (process.env.RPC_URL_BASE || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY || "").trim();
const SHARED_SECRET   = (process.env.SHARED_SECRET || "").trim();

const PERCENT_TO_SWAP = BigInt(parseInt(process.env.PERCENT_TO_SWAP || "90", 10));
const SLIPPAGE_BPS    = BigInt(parseInt(process.env.SLIPPAGE_BPS || "50", 10));
const DRY_RUN         = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

const WALLET_WHITELIST = (process.env.WALLET_WHITELIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ========== АДРЕСА ==========

const CHAIN_ID_BASE = 8453;

const USDC_ADDRESS        = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH_ADDRESS        = "0x4200000000000000000000000000000000000006";
const SWAP_ROUTER_ADDRESS = "0x2626664c2603336e57b271c5c0b26f421741e481";

const DEFAULT_POOL_FEE = 500;

// ========== ABI ==========

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)"
];

// ВАЖНО: правильный ABI Uniswap v3 exactInputSingle
const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)"
];

const WETH_ABI = [
  "function balanceOf(address owner) view returns (uint256)"
];

// ========== HELPERS ==========

function getProvider() {
  if (!RPC_URL_BASE) throw new Error("RPC_URL_BASE is not set");
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
    try { return JSON.parse(raw.trim()); } catch {
      return { _raw: raw.trim() };
    }
  }
  return { _raw: raw };
}

async function getNinetyPercentToken(contract, address) {
  const bal = await contract.balanceOf(address);
  if (bal === 0n) throw new Error("Token balance is zero");
  const amount = (bal * PERCENT_TO_SWAP) / 100n;
  if (amount <= 0n) throw new Error("Token amount to swap is zero");
  return { balance: bal, amount };
}

// ========== SWAPS ==========

// BUY → USDC → WETH
async function swapUsdcToWeth(wallet) {
  const provider = wallet.provider;
  const address  = await wallet.getAddress();

  const usdc   = new Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const weth   = new Contract(WETH_ADDRESS, WETH_ABI, wallet);
  const router = new Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);

  const usdcDecimals = await usdc.decimals();

  const { balance: usdcBalance, amount: amountIn } =
    await getNinetyPercentToken(usdc, address);

  const allowance = await usdc.allowance(address, SWAP_ROUTER_ADDRESS);
  if (!DRY_RUN && allowance < amountIn) {
    const approveTx = await usdc.approve(SWAP_ROUTER_ADDRESS, MaxUint256);
    await approveTx.wait();
  }

  const deadline = Math.floor(Date.now() / 1000) + 600;

  // ВАЖНО: tuple передается КАК МАССИВ
  const params = [
    USDC_ADDRESS,
    WETH_ADDRESS,
    DEFAULT_POOL_FEE,
    address,
    deadline,
    amountIn,
    0n,
    0n
  ];

  if (DRY_RUN) {
    const ethBal = await provider.getBalance(address);
    const wethBal = await weth.balanceOf(address);

    return {
      mode: "dry-run",
      direction: "USDC_TO_WETH",
      router: SWAP_ROUTER_ADDRESS,
      poolFee: DEFAULT_POOL_FEE,
      amountIn: amountIn.toString(),
      amountOutMinimum: "0",
      usdcBalance: usdcBalance.toString(),
      usdcBalanceHuman: formatUnits(usdcBalance, usdcDecimals),
      ethBalanceWei: ethBal.toString(),
      wethBalanceWei: wethBal.toString()
    };
  }

  const tx = await router.exactInputSingle(params);
  const receipt = await tx.wait();

  const wethAfter = await weth.balanceOf(address);

  return {
    mode: "live",
    direction: "USDC_TO_WETH",
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    amountIn: amountIn.toString(),
    amountOutMinimum: "0",
    wethBalanceAfter: wethAfter.toString(),
    usdcBalanceBefore: usdcBalance.toString(),
    usdcBalanceBeforeHuman: formatUnits(usdcBalance, usdcDecimals)
  };
}

// SELL → WETH → USDC
async function swapWethToUsdc(wallet) {
  const provider = wallet.provider;
  const address  = await wallet.getAddress();

  const usdc   = new Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const weth   = new Contract(WETH_ADDRESS, ERC20_ABI, wallet);
  const router = new Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);

  const usdcDecimals = await usdc.decimals();

  const { balance: wethBalance, amount: amountIn } =
    await getNinetyPercentToken(weth, address);

  const allowance = await weth.allowance(address, SWAP_ROUTER_ADDRESS);
  if (!DRY_RUN && allowance < amountIn) {
    const approveTx = await weth.approve(SWAP_ROUTER_ADDRESS, MaxUint256);
    await approveTx.wait();
  }

  const deadline = Math.floor(Date.now() / 1000) + 600;

  const params = [
    WETH_ADDRESS,
    USDC_ADDRESS,
    DEFAULT_POOL_FEE,
    address,
    deadline,
    amountIn,
    0n,
    0n
  ];

  if (DRY_RUN) {
    const ethBal = await provider.getBalance(address);
    const usdcBal = await usdc.balanceOf(address);

    return {
      mode: "dry-run",
      direction: "WETH_TO_USDC",
      router: SWAP_ROUTER_ADDRESS,
      poolFee: DEFAULT_POOL_FEE,
      amountIn: amountIn.toString(),
      amountOutMinimum: "0",
      wethBalance: wethBalance.toString(),
      ethBalanceWei: ethBal.toString(),
      usdcBalanceWei: usdcBal.toString(),
      usdcBalanceHuman: formatUnits(usdcBal, usdcDecimals)
    };
  }

  const tx = await router.exactInputSingle(params);
  const receipt = await tx.wait();

  const usdcAfter = await usdc.balanceOf(address);

  return {
    mode: "live",
    direction: "WETH_TO_USDC",
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    amountIn: amountIn.toString(),
    amountOutMinimum: "0",
    wethBalanceBefore: wethBalance.toString(),
    usdcBalanceAfter: usdcAfter.toString(),
    usdcBalanceAfterHuman: formatUnits(usdcAfter, usdcDecimals)
  };
}

// ========== EXPRESS APP ==========

const app = express();
app.use(bodyParser.json({ limit: "200kb" }));
app.use(bodyParser.text({ limit: "200kb", type: "*/*" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "tv-webhookl", ts: new Date().toISOString() });
});

app.get("/diag", async (_req, res) => {
  try {
    const provider = getProvider();
    const wallet   = getWallet(provider);
    const address  = await wallet.getAddress();

    const baseBalance = await provider.getBalance(address);

    let usdcRaw = null;
    let usdcHuman = null;
    let wethRaw = null;
    let wethHuman = null;
    let usdcAllowanceRaw = null;
    let wethAllowanceRaw = null;
    let usdcDecimals = 6;

    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const weth = new Contract(WETH_ADDRESS, ERC20_ABI, provider);

    const [usdcBal, dec, wethBal, usdcAllow, wethAllow] = await Promise.all([
      usdc.balanceOf(address),
      usdc.decimals(),
      weth.balanceOf(address),
      usdc.allowance(address, SWAP_ROUTER_ADDRESS),
      weth.allowance(address, SWAP_ROUTER_ADDRESS)
    ]);

    usdcDecimals      = Number(dec);
    usdcRaw           = usdcBal.toString();
    usdcHuman         = formatUnits(usdcBal, usdcDecimals);
    wethRaw           = wethBal.toString();
    wethHuman         = formatUnits(wethBal, 18);
    usdcAllowanceRaw  = usdcAllow.toString();
    wethAllowanceRaw  = wethAllow.toString();

    const canBuy  = BigInt(usdcRaw) > 0n;
    const canSell = BigInt(wethRaw) > 0n;

    res.json({
      ok: true,
      address,
      chainId: CHAIN_ID_BASE,
      DRY_RUN,
      router: SWAP_ROUTER_ADDRESS,
      defaultPoolFee: DEFAULT_POOL_FEE,
      balances: {
        eth: formatUnits(baseBalance, 18),
        usdc: usdcHuman,
        weth: wethHuman
      },
      allowance: {
        usdcAllowanceWei: usdcAllowanceRaw,
        wethAllowanceWei: wethAllowanceRaw
      },
      directions: {
        canBuy_USDC_to_WETH: canBuy,
        canSell_WETH_to_USDC: canSell
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body) || {};

    const hdrSecret  = req.get("X-Secret") || req.get("x-secret") || "";
    const bodySecret = typeof body.secret === "string" ? body.secret : "";
    const provided   = hdrSecret || bodySecret;

    if (!SHARED_SECRET) return res.status(500).json({ ok: false, error: "server_misconfigured_no_secret" });
    if (provided !== SHARED_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });

    const p = body;

    const provider = getProvider();
    const wallet   = getWallet(provider);

    const side = String(p.side || "").toUpperCase();

    let result;
    if (side === "BUY") {
      result = await swapUsdcToWeth(wallet);
    } else if (side === "SELL") {
      result = await swapWethToUsdc(wallet);
    } else {
      throw new Error(`Unknown side: ${p.side}`);
    }

    return res.json({ ok: true, ...result });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ ok: false, error: err.message || "internal_error" });
  }
});

// ========== START ==========

app.listen(PORT, () => {
  console.log(`tv-webhookl started on port ${PORT}`);
});
