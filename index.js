// =============================
//   RAWMOVE • LIVE SWAP ENGINE
//       ETH ⇄ USDC (Base)
//       90% BALANCE MODEL
// =============================
import express from "express";
import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet, Contract, parseUnits } from "ethers";
import fetch from "node-fetch";

// ENV
const PORT = process.env.PORT || 10000;
const SHARED_SECRET   = (process.env.SHARED_SECRET || "").trim();
const PRIVATE_KEY_RAW = (process.env.PRIVATE_KEY  || "").trim();
const DRY_RUN = false;

// RPC
const RPC_URL_BASE = (process.env.RPC_URL_BASE || "").trim();
if (!RPC_URL_BASE) throw new Error("RPC_URL_BASE not configured");

const providerBase = new JsonRpcProvider(RPC_URL_BASE, 8453);

// TOKENS
const TOKENS = {
  ETH_ZERO:  "0x0000000000000000000000000000000000000000",
  ETH_EEEE:  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  USDC:      "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913"
};

// 0x API endpoint (Base Mainnet)
const ZEROX_QUOTE = "https://base.api.0x.org/swap/v1/quote";

// Minimal ABI for ERC20 balance/approval
const ERC20_ABI = [
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns (bool)"
];

// App
const app = express();
app.use(bodyParser.json({ limit: "200kb" }));

// Helpers
function getWallet() {
  const pk = PRIVATE_KEY_RAW.startsWith("0x") ? PRIVATE_KEY_RAW : "0x" + PRIVATE_KEY_RAW;
  return new Wallet(pk, providerBase);
}

async function get90pctETH(wallet) {
  const bal = await wallet.getBalance();
  return bal * 90n / 100n;
}

async function get90pctUSDC(wallet) {
  const usdc = new Contract(TOKENS.USDC, ERC20_ABI, providerBase);
  const bal = await usdc.balanceOf(await wallet.getAddress());
  return bal * 90n / 100n;
}

// ROUTE: HEALTH
app.get("/", (_, res) => res.json({ ok: true, mode: "live" }));

// ROUTE: DIAG
app.get("/diag", async (_, res) => {
  try {
    const wallet = getWallet();
    const addr   = await wallet.getAddress();
    const balETH = await providerBase.getBalance(addr);
    const usdc = new Contract(TOKENS.USDC, ERC20_ABI, providerBase);
    const balUSDC = await usdc.balanceOf(addr);

    res.json({
      ok: true,
      chainId: 8453,
      wallet: addr,
      balanceETH: balETH.toString(),
      balanceUSDC: balUSDC.toString(),
      DRY_RUN
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// MAIN EXECUTION
app.post("/", async (req, res) => {
  try {
    // SECRET CHECK
    const provided = req.get("X-Secret") || req.body.secret || "";
    if (provided !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const wallet = getWallet();
    const address = await wallet.getAddress();

    const p = req.body;
    const side = String(p.side || "").toUpperCase();

    let sellToken;
    let buyToken;
    let sellAmount;

    // SIDE LOGIC
    if (side === "SELL") {
      sellToken = TOKENS.ETH_EEEE;
      buyToken  = TOKENS.USDC;
      sellAmount = await get90pctETH(wallet);
    }

    else if (side === "BUY") {
      sellToken = TOKENS.USDC;
      buyToken  = TOKENS.ETH_EEEE;
      sellAmount = await get90pctUSDC(wallet);
    }

    else {
      throw new Error("Invalid side, use BUY or SELL");
    }

    if (sellAmount <= 0n) {
      throw new Error("Insufficient balance for 90% model");
    }

    const sellAmountDec = sellAmount.toString();

    // 0x Quote
    const url = `${ZEROX_QUOTE}?sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmountDec}&takerAddress=${address}&slippagePercentage=0.015`;

    const quote = await fetch(url).then(r => r.json());
    if (!quote || !quote.to || !quote.data) {
      return res.status(500).json({ ok: false, error: "0x quote failed", quote });
    }

    // USDC approval if BUY (USDC → ETH)
    if (side === "BUY") {
      const usdc = new Contract(TOKENS.USDC, ERC20_ABI, wallet);
      const approveTx = await usdc.approve(quote.allowanceTarget, sellAmountDec);
      await approveTx.wait(1);
    }

    // SEND TX
    const tx = await wallet.sendTransaction({
      to: quote.to,
      data: quote.data,
      value: quote.value ? BigInt(quote.value) : 0n,
      gasLimit: quote.gas || 350000n
    });

    return res.json({
      ok: true,
      mode: "live",
      side,
      sellAmount: sellAmountDec,
      txHash: tx.hash,
      route: quote.sources,
      price: quote.price
    });

  } catch (err) {
    console.error("LIVE ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// START
app.listen(PORT, () => {
  console.log("LIVE SWAP ENGINE READY on port", PORT);
});
