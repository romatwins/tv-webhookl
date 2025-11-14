// index.js
// Base, Uniswap v3 SwapRouter02
// Два режима:
//   SWAP_DIRECTION=USDC_TO_ETH  -> 90% USDC => ETH
//   SWAP_DIRECTION=ETH_TO_USDC  -> 90% ETH  => USDC
// amountOutMinimum считается через QuoterV2 с 1% slippage

import "dotenv/config";
import { ethers } from "ethers";

// ========= КОНФИГ ЧЕРЕЗ ENV =========

// .env пример:
// RPC_URL_BASE=https://mainnet.base.org
// PRIVATE_KEY=0x....
// SWAP_DIRECTION=USDC_TO_ETH   или ETH_TO_USDC
// PERCENT_TO_SWAP=90
// POOL_FEE=500

const RPC_URL         = process.env.RPC_URL_BASE || "https://mainnet.base.org";
const PRIVATE_KEY     = (process.env.PRIVATE_KEY || "").trim();
const SWAP_DIRECTION  = (process.env.SWAP_DIRECTION || "USDC_TO_ETH").trim();
const PERCENT_TO_SWAP = Number(process.env.PERCENT_TO_SWAP || "90");
const POOL_FEE        = Number(process.env.POOL_FEE || "500");

// адреса контрактов на Base
const USDC_ADDRESS    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_ADDRESS    = "0x4200000000000000000000000000000000000006";
const ROUTER_ADDRESS  = "0x2626664c2603336E57B271c5C0b26F421741e481";

// QuoterV2 на Base
const QUOTER_ADDRESS  = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";

// 1% slippage
const SLIPPAGE_BPS = 100;   // 100 bps = 1%

// ========= ПРОВЕРКИ =========

if (!PRIVATE_KEY) {
  console.error("ERROR: PRIVATE_KEY is not set in ENV");
  process.exit(1);
}

if (PERCENT_TO_SWAP <= 0 || PERCENT_TO_SWAP > 100) {
  console.error("ERROR: PERCENT_TO_SWAP must be in (0,100], got:", PERCENT_TO_SWAP);
  process.exit(1);
}

if (SWAP_DIRECTION !== "USDC_TO_ETH" && SWAP_DIRECTION !== "ETH_TO_USDC") {
  console.error("ERROR: SWAP_DIRECTION must be USDC_TO_ETH or ETH_TO_USDC, got:", SWAP_DIRECTION);
  process.exit(1);
}

// ========= ABI =========

const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

const swapRouterAbi = [
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

const wethAbi = [
  "function withdraw(uint256 wad) public",
  "function deposit() public payable",
  "function balanceOf(address owner) view returns (uint256)"
];

// QuoterV2: quoteExactInputSingle
const quoterAbi = [
  "function quoteExactInputSingle(tuple(" +
  "address tokenIn," +
  "address tokenOut," +
  "uint256 amountIn," +
  "uint24 fee," +
  "uint160 sqrtPriceLimitX96" +
  ") params) external returns (" +
  "uint256 amountOut," +
  "uint160 sqrtPriceX96After," +
  "uint32 initializedTicksCrossed," +
  "uint256 gasEstimate" +
  ")"
];

// ========= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =========

// расчёт минимального выхода по котировке QuoterV2 с 1% слippage
async function getAmountOutMin(quoter, paramsForQuote) {
  const [amountOut] = await quoter.quoteExactInputSingle(paramsForQuote);
  if (amountOut <= 0n) {
    throw new Error("Quoter returned zero amountOut");
  }
  const bps = BigInt(10_000 - SLIPPAGE_BPS); // 9900 для 1%
  const minOut = (amountOut * bps) / 10_000n;
  if (minOut <= 0n) {
    throw new Error("amountOutMinimum computed as zero");
  }
  return { amountOut, minOut };
}

async function swapUsdcToEth(wallet, provider) {
  const usdc   = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);
  const router = new ethers.Contract(ROUTER_ADDRESS, swapRouterAbi, wallet);
  const weth   = new ethers.Contract(WETH_ADDRESS, wethAbi, wallet);
  const quoter = new ethers.Contract(QUOTER_ADDRESS, quoterAbi, provider);

  const [usdcBalance, usdcDecimals] = await Promise.all([
    usdc.balanceOf(wallet.address),
    usdc.decimals()
  ]);

  if (usdcBalance === 0n) {
    console.log("USDC balance is zero, nothing to swap.");
    return;
  }

  const balanceUsdcHuman = ethers.formatUnits(usdcBalance, usdcDecimals);
  console.log("USDC balance:", balanceUsdcHuman, "USDC");

  const amountIn = (usdcBalance * BigInt(PERCENT_TO_SWAP)) / 100n;
  if (amountIn <= 0n) {
    console.log("Computed amountIn is zero, aborting.");
    return;
  }

  console.log(
    `Swapping ${PERCENT_TO_SWAP}% of USDC ->`,
    ethers.formatUnits(amountIn, usdcDecimals),
    "USDC"
  );

  const allowance = await usdc.allowance(wallet.address, ROUTER_ADDRESS);
  console.log("Current USDC allowance:", allowance.toString());

  if (allowance < amountIn) {
    console.log("Approving USDC for router...");
    const approveTx = await usdc.approve(ROUTER_ADDRESS, ethers.MaxUint256);
    console.log("Approve sent, tx hash:", approveTx.hash);
    const approveRc = await approveTx.wait();
    console.log("Approve confirmed in block", approveRc.blockNumber);
  } else {
    console.log("Allowance is sufficient, skip approve.");
  }

  const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // 10 минут

  // параметры для Quoter
  const quoteParams = {
    tokenIn: USDC_ADDRESS,
    tokenOut: WETH_ADDRESS,
    amountIn,
    fee: POOL_FEE,
    sqrtPriceLimitX96: 0n
  };

  console.log("Querying QuoterV2 for USDC -> WETH...");
  const { amountOut, minOut } = await getAmountOutMin(quoter, quoteParams);

  console.log(
    "Quoted amountOut WETH:",
    ethers.formatEther(amountOut)
  );
  console.log(
    "amountOutMinimum (1% slippage):",
    ethers.formatEther(minOut)
  );

  const params = {
    tokenIn: USDC_ADDRESS,
    tokenOut: WETH_ADDRESS,
    fee: POOL_FEE,
    recipient: wallet.address,
    deadline,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n
  };

  console.log("Sending swap USDC -> WETH...");

  const tx = await router.exactInputSingle(params, { value: 0n });
  console.log("Swap tx hash:", tx.hash);
  const rc = await tx.wait();
  console.log("Swap confirmed in block", rc.blockNumber);

  const wethBalance = await weth.balanceOf(wallet.address);
  console.log("WETH balance after swap:", ethers.formatEther(wethBalance), "WETH");

  if (wethBalance > 0n) {
    console.log("Unwrapping WETH -> ETH...");
    const unwrapTx = await weth.withdraw(wethBalance);
    console.log("Unwrap tx hash:", unwrapTx.hash);
    const unwrapRc = await unwrapTx.wait();
    console.log("Unwrap confirmed in block", unwrapRc.blockNumber);
  } else {
    console.log("Nothing to unwrap, WETH balance is zero.");
  }

  console.log("USDC -> ETH done.");
}

async function swapEthToUsdc(wallet, provider) {
  const router = new ethers.Contract(ROUTER_ADDRESS, swapRouterAbi, wallet);
  const weth   = new ethers.Contract(WETH_ADDRESS, wethAbi, wallet);
  const usdc   = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);
  const quoter = new ethers.Contract(QUOTER_ADDRESS, quoterAbi, provider);

  const ethBalance = await provider.getBalance(wallet.address);
  console.log("ETH balance:", ethers.formatEther(ethBalance), "ETH");

  if (ethBalance === 0n) {
    console.log("ETH balance is zero, nothing to swap.");
    return;
  }

  const amountEth = (ethBalance * BigInt(PERCENT_TO_SWAP)) / 100n;
  if (amountEth <= 0n) {
    console.log("Computed amountEth is zero, aborting.");
    return;
  }

  console.log(
    `Swapping ${PERCENT_TO_SWAP}% of ETH ->`,
    ethers.formatEther(amountEth),
    "ETH"
  );

  console.log("Wrapping ETH -> WETH...");
  const wrapTx = await weth.deposit({ value: amountEth });
  console.log("Wrap tx hash:", wrapTx.hash);
  const wrapRc = await wrapTx.wait();
  console.log("Wrap confirmed in block", wrapRc.blockNumber);

  const wethBalance = await weth.balanceOf(wallet.address);
  console.log("WETH balance after wrap:", ethers.formatEther(wethBalance), "WETH");

  if (wethBalance <= 0n) {
    console.log("No WETH after wrap, abort.");
    return;
  }

  const amountIn = wethBalance;

  const deadline = Math.floor(Date.now() / 1000) + 60 * 10;

  // Quoter для WETH -> USDC
  const quoteParams = {
    tokenIn: WETH_ADDRESS,
    tokenOut: USDC_ADDRESS,
    amountIn,
    fee: POOL_FEE,
    sqrtPriceLimitX96: 0n
  };

  console.log("Querying QuoterV2 for WETH -> USDC...");
  const { amountOut, minOut } = await getAmountOutMin(quoter, quoteParams);

  const usdcDecimals = await usdc.decimals();

  console.log(
    "Quoted amountOut USDC:",
    ethers.formatUnits(amountOut, usdcDecimals)
  );
  console.log(
    "amountOutMinimum (1% slippage):",
    ethers.formatUnits(minOut, usdcDecimals)
  );

  const params = {
    tokenIn: WETH_ADDRESS,
    tokenOut: USDC_ADDRESS,
    fee: POOL_FEE,
    recipient: wallet.address,
    deadline,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n
  };

  console.log("Sending swap WETH -> USDC...");

  const tx = await router.exactInputSingle(params, { value: 0n });
  console.log("Swap tx hash:", tx.hash);
  const rc = await tx.wait();
  console.log("Swap confirmed in block", rc.blockNumber);

  const usdcBalanceAfter = await usdc.balanceOf(wallet.address);
  console.log(
    "USDC balance after swap:",
    ethers.formatUnits(usdcBalanceAfter, usdcDecimals),
    "USDC"
  );

  console.log("ETH -> USDC done.");
}

// ========= MAIN =========

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("RPC:", RPC_URL);
  console.log("Wallet:", wallet.address);
  console.log("SWAP_DIRECTION:", SWAP_DIRECTION);
  console.log("PERCENT_TO_SWAP:", PERCENT_TO_SWAP);
  console.log("POOL_FEE:", POOL_FEE);
  console.log("QuoterV2:", QUOTER_ADDRESS);

  if (SWAP_DIRECTION === "USDC_TO_ETH") {
    await swapUsdcToEth(wallet, provider);
  } else {
    await swapEthToUsdc(wallet, provider);
  }

  console.log("All done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
