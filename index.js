// index.js — боевой режим ETH⇄USDC, 90% баланса, 0x swap
import express from "express";
import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet, parseUnits } from "ethers";
import fetch from "node-fetch";

// ---- ENV ----
const PORT = process.env.PORT || 10000;
const SHARED_SECRET = (process.env.SHARED_SECRET || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY || "").trim();
const DRY_RUN = false;  // боевой режим включён всегда

const RPCS = {
  8453: (process.env.RPC_URL_BASE || "").trim()
};

// ETH + USDC addresses
const TOKENS = {
  ETH_ZERO: "0x0000000000000000000000000000000000000000",
  ETH_EEEE: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  USDC:     "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913"
};

// ---- Express ----
const app = express();
app.use(bodyParser.json({ limit: "300kb" }));
app.use(bodyParser.text({ limit: "300kb", type: "*/*" }));

function normalizeBody(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw.trim()); }
    catch { return { _raw: raw.trim() }; }
  }
  return { _raw: raw };
}

function getProvider() {
  const url = RPCS[8453];
  if (!url) throw new Error("RPC_URL_BASE is not configured");
  return new JsonRpcProvider(url, 8453);
}

function getWallet(provider) {
  const pk = PRIVATE_KEY_RAW.startsWith("0x")
    ? PRIVATE_KEY_RAW
    : "0x" + PRIVATE_KEY_RAW;

  return new Wallet(pk, provider);
}

async function get90(wallet) {
  const addr = await wallet.getAddress();
  const bal = await wallet.provider.getBalance(addr);
  const ninety = bal * 90n / 100n;
  if (ninety <= 0n) throw new Error("Balance too low for 90%");
  return ninety;
}

// ---- HEALTH ----
app.get("/env", (req, res) => {
  res.json({
    ok: true,
    DRY_RUN,
    HAS_SECRET: !!SHARED_SECRET,
    HAS_KEY: !!PRIVATE_KEY_RAW,
    RPC_BASE: !!RPCS[8453]
  });
});

app.get("/diag", async (req, res) => {
  try {
    const provider = getProvider();
    const wallet = getWallet(provider);
    const addr = await wallet.getAddress();
    const bal = await provider.getBalance(addr);

    res.json({
      ok: true,
      chainId: 8453,
      address: addr,
      balanceWei: bal.toString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- MAIN SWAP ----
app.post("/", async (req, res) => {
  try {
    const body = normalizeBody(req.body) || {};

    // SECRET
    const incoming = req.get("X-Secret") || body.secret || "";
    if (incoming !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const provider = getProvider();
    const wallet = getWallet(provider);
    const address = await wallet.getAddress();

    const src = body.srcToken.toLowerCase();
    const dst = body.dstToken.toLowerCase();

    const isSellEth = src === TOKENS.ETH_ZERO || src === TOKENS.ETH_EEEE;
    const isBuyEth  = dst === TOKENS.ETH_ZERO || dst === TOKENS.ETH_EEEE;

    if (!isSellEth && !isBuyEth) {
      throw new Error("Only ETH⇄USDC swaps allowed");
    }

    // ----- SELL ETH = use 90% ETH balance -----
    let sellAmountWei = null;
    if (isSellEth) {
      sellAmountWei = await get90(wallet);
    } else {
      throw new Error("Buying ETH from USDC not implemented yet");
    }

    // ------ 0x Quote ------
    const sellToken = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const buyToken = TOKENS.USDC;
    const amount = sellAmountWei.toString();

    const url = `https://base.api.0x.org/swap/v1/quote?buyToken=${buyToken}&sellToken=${sellToken}&sellAmount=${amount}&slippageBps=50`;

    const quote = await fetch(url).then(r => r.json());

    if (quote.code || quote.validationErrors) {
      throw new Error("0x quote failed: " + JSON.stringify(quote));
    }

    // ----- SEND TX -----
    const tx = await wallet.sendTransaction({
      to: quote.to,
      data: quote.data,
      value: sellAmountWei,
      gasLimit: 350000
    });

    console.log("LIVE SWAP SENT:", tx.hash);

    return res.json({
      ok: true,
      mode: "live",
      txHash: tx.hash,
      sellAmountWei,
      wallet: address
    });

  } catch (e) {
    console.error("Swap error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("LIVE WEBHOOK STARTED on", PORT);
});
