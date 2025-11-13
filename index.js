// index.js — боевой двухсторонний swap ETH⇄USDC через 0x с whitelist + safe-approve

import express from "express";
import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import fetch from "node-fetch";

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const SHARED_SECRET   = (process.env.SHARED_SECRET || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY  || "").trim();
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

const RPCS = {
  1:      (process.env.RPC_URL_ETH  || process.env.RPC_ETH  || "").trim(),
  8453:   (process.env.RPC_URL_BASE || process.env.RPC_BASE || process.env.RPC || "").trim(),
  42161:  (process.env.RPC_URL_ARB  || process.env.RPC_ARB  || "").trim(),
};

// ==== WHITELIST ====
const WALLET_WHITELIST = (process.env.WALLET_WHITELIST || "")
  .split(",")
  .map(a => a.trim().toLowerCase())
  .filter(Boolean);

const ROUTER_WHITELIST = (process.env.ROUTER_WHITELIST || "")
  .split(",")
  .map(a => a.trim().toLowerCase())
  .filter(Boolean);

// ===== CONSTANTS =====
const TOKENS = {
  ETH_ZERO:  "0x0000000000000000000000000000000000000000",
  ETH_EEEE:  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  USDC_BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913"
};

const ZEROX_BASE_URL = "https://base.api.0x.org";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// ===== HELPERS =====

function normalizeBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw.trim()); }
    catch { return { _raw: raw }; }
  }
  return { _raw: raw };
}

function getProvider(chainId) {
  const url = RPCS[chainId];
  if (!url) throw new Error(`RPC not configured for chainId ${chainId}`);
  return new JsonRpcProvider(url, chainId);
}

function getWallet(provider) {
  if (!PRIVATE_KEY_RAW) throw new Error("PRIVATE_KEY is not set");
  const pk = PRIVATE_KEY_RAW.startsWith("0x") ? PRIVATE_KEY_RAW : "0x" + PRIVATE_KEY_RAW;
  return new Wallet(pk, provider);
}

function isEthLike(a) {
  a = String(a || "").toLowerCase();
  return (
    a === TOKENS.ETH_ZERO.toLowerCase() ||
    a === TOKENS.ETH_EEEE.toLowerCase()
  );
}

// 90% ETH
async function get90pctETH(wallet) {
  const bal = await wallet.provider.getBalance(await wallet.getAddress());
  const ninety = bal * 90n / 100n;
  if (ninety <= 0n) throw new Error("ETH balance too low for 90%");
  return ninety;
}

// 90% USDC
async function get90pctUSDC(wallet, provider) {
  const usdc = new Contract(TOKENS.USDC_BASE, ERC20_ABI, provider);
  const bal = await usdc.balanceOf(await wallet.getAddress());
  const ninety = bal * 90n / 100n;
  if (ninety <= 0n) throw new Error("USDC balance too low for 90%");
  return { usdc, ninety };
}

// ===== APP =====
const app = express();
app.use(bodyParser.json({ limit: "200kb" }));
app.use(bodyParser.text({ type: "*/*" }));

// ===== DIAGNOSTICS =====
app.get("/", (_req,res)=>res.json({ok:true,ts:new Date().toISOString()}));
app.get("/test", (_req,res)=>res.json({ok:true}));

app.get("/env", (_req,res)=>{
  res.json({
    ok:true,
    DRY_RUN,
    RPC_BASE: !!RPCS[8453],
    HAS_SECRET: !!SHARED_SECRET,
    HAS_KEY: !!PRIVATE_KEY_RAW,
    WALLET_WHITELIST,
    ROUTER_WHITELIST
  });
});

app.get("/diag", async (_req,res)=>{
  try{
    const provider = getProvider(8453);
    const wallet = getWallet(provider);
    const addr = await wallet.getAddress();
    const balance = await provider.getBalance(addr);
    res.json({
      ok:true,
      addr,
      balanceWei: balance.toString(),
      whitelisted: WALLET_WHITELIST.length === 0 || 
                   WALLET_WHITELIST.includes(addr.toLowerCase())
    });
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

// ===== MAIN SWAP HANDLER =====
app.post("/", async (req,res)=>{
  try{
    const p = normalizeBody(req.body);
    if (!p) throw new Error("empty payload");

    // Secret
    const hdrSec = req.get("X-Secret") || "";
    const provided = hdrSec || p.secret;
    if (provided !== SHARED_SECRET) {
      return res.status(401).json({ok:false,error:"unauthorized"});
    }

    // Validate
    const fields = [
      "action","side","chainId","srcToken","dstToken",
      "amountMode","amountValue","slippageBps","deadlineSec",
      "symbol","tf","signalId"
    ];
    const missing = fields.filter(f=>!(f in p));
    if (missing.length) {
      return res.status(400).json({ok:false,error:"invalid payload",missing});
    }

    const chainId = Number(p.chainId);
    if (chainId !== 8453) throw new Error("Only Base chain supported");

    const provider = getProvider(chainId);
    const wallet = getWallet(provider);
    const addr = await wallet.getAddress();

    if (WALLET_WHITELIST.length>0 &&
        !WALLET_WHITELIST.includes(addr.toLowerCase()))
      throw new Error("Wallet not whitelisted");

    if (DRY_RUN) {
      return res.json({ok:true,mode:"dry-run",addr,received:p});
    }

    const src = p.srcToken.toLowerCase();
    const dst = p.dstToken.toLowerCase();

    // ==== USDC → ETH ====
    if (src === TOKENS.USDC_BASE.toLowerCase() && isEthLike(dst)) {

      const { usdc, ninety } = await get90pctUSDC(wallet, provider);
      const sellAmount = ninety;

      const slippage = Number(p.slippageBps)/10_000;

      const qs = new URLSearchParams({
        sellToken: TOKENS.USDC_BASE,
        buyToken: TOKENS.ETH_EEEE,
        sellAmount: sellAmount.toString(),
        takerAddress: addr,
        slippagePercentage: slippage.toString()
      });

      const r = await fetch(`${ZEROX_BASE_URL}/swap/v1/quote?${qs}`);
      if (!r.ok) throw new Error("0x quote failed");
      const quote = await r.json();

      const router = quote.to.toLowerCase();
      if (ROUTER_WHITELIST.length>0 &&
          !ROUTER_WHITELIST.includes(router))
        throw new Error("Router not whitelisted");

      // Approve USDC
      const approveTx = await usdc.connect(wallet).approve(router, sellAmount);
      await approveTx.wait();

      const tx = await wallet.sendTransaction({
        to: quote.to,
        data: quote.data,
        value: 0n
      });

      return res.json({
        ok:true,
        mode:"live-sent-usdc-eth",
        txHash: tx.hash,
        router,
        sellAmount: sellAmount.toString(),
        buyAmount: quote.buyAmount
      });
    }

    // ==== ETH → USDC ====
    if (isEthLike(src) && dst === TOKENS.USDC_BASE.toLowerCase()) {

      const sellAmount = await get90pctETH(wallet);
      const slippage = Number(p.slippageBps)/10_000;

      const qs = new URLSearchParams({
        sellToken: TOKENS.ETH_EEEE,
        buyToken: TOKENS.USDC_BASE,
        sellAmount: sellAmount.toString(),
        takerAddress: addr,
        slippagePercentage: slippage.toString()
      });

      const r = await fetch(`${ZEROX_BASE_URL}/swap/v1/quote?${qs}`);
      if (!r.ok) throw new Error("0x quote failed");
      const quote = await r.json();

      const router = quote.to.toLowerCase();
      if (ROUTER_WHITELIST.length>0 &&
          !ROUTER_WHITELIST.includes(router))
        throw new Error("Router not whitelisted");

      const tx = await wallet.sendTransaction({
        to: quote.to,
        data: quote.data,
        value: BigInt(quote.value || "0")
      });

      return res.json({
        ok:true,
        mode:"live-sent-eth-usdc",
        txHash: tx.hash,
        router,
        sellAmount: sellAmount.toString(),
        buyAmount: quote.buyAmount
      });
    }

    throw new Error("Direction not supported. Allowed: ETH→USDC or USDC→ETH");

  }catch(e){
    console.error("ERROR:",e);
    res.status(500).json({ok:false,error:e.message});
  }
});

// ===== START =====
app.listen(PORT, ()=>{
  console.log("tv-webhookl started on",PORT);
});
