const ethers = require("ethers");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const RPC_URL = process.env.RPC_URL;
const STATIC_CHAT_ID = process.env.STATIC_CHAT_ID?.trim();
const THRESHOLD_USD = parseFloat(process.env.THRESHOLD_USD || "1000");
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "60000");

if (!BOT_TOKEN || !RPC_URL) {
  console.error("❌ BOT_TOKEN или RPC_URL не заданы в переменных окружения.");
  process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
let ACTIVE_CHAT_ID = STATIC_CHAT_ID || null;

const pools = [
  { name: "USDT", address: "0x48759F220ED983dB51fA7A8C0D2AAb8f3ce4166a", decimals: 6 },
  { name: "USDC", address: "0x76Eb2FE28b36B3ee97F3Adae0C69606eeDB2A37c", decimals: 6 },
  { name: "DAI",  address: "0x8e595470Ed749b85C6F7669de83EAe304C2ec68F", decimals: 18 },
  { name: "ETH",  address: "0x41c84c0e2EE0b740Cf0d31F63f3B6F627DC6b393", decimals: 18 }
];

const selfMonitor = {
  address: "0x2a4cE5BaCcB98E5F95D37F8B3D1065754E0389CD",
  lastStatus: "safe"
};

const lastCashValues = {};

async function getCash(pool) {
  const cToken = new ethers.Contract(pool.address, ["function getCash() view returns (uint256)"], provider);
  const rawCash = await cToken.getCash();
  return parseFloat(ethers.utils.formatUnits(rawCash, pool.decimals));
}

async function sendTelegramMessage(text, chatId = ACTIVE_CHAT_ID) {
  if (!chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error("❌ Telegram Error:", err.response?.data || err.message);
  }
}

async function getEthPrice() {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    return res.data.ethereum.usd;
  } catch {
    return 0;
  }
}

async function calculateHealthFactor() {
  const comptrollerAddress = "0xAB1c342C7bf5Ec5F02ADEA1c2270670bCa144CbB";
  const comptrollerAbi = ["function markets(address) view returns (bool, uint256, bool)"];
  const cTokenAbi = [
    "function balanceOf(address) view returns (uint)",
    "function borrowBalanceStored(address) view returns (uint)",
    "function exchangeRateStored() view returns (uint)"
  ];

  const comptroller = new ethers.Contract(comptrollerAddress, comptrollerAbi, provider);
  const user = selfMonitor.address;
  const breakdown = [];

  let totalCollateral = 0;
  let totalBorrow = 0;
  let ethCollateralUSD = 0;
  let ethBorrowInETH = 0;

  const ethPrice = await getEthPrice();

  for (const pool of pools) {
    const cToken = new ethers.Contract(pool.address, cTokenAbi, provider);
    const [cBal, borrow, rate] = await Promise.all([
      cToken.balanceOf(user),
      cToken.borrowBalanceStored(user),
      cToken.exchangeRateStored()
    ]);

    const [, collateralFactor] = await comptroller.markets(pool.address);

    // Подсчёт в underlying токенах
    const cTokenBalance = parseFloat(ethers.utils.formatUnits(cBal, 8));
    const exchangeRate = parseFloat(ethers.utils.formatUnits(rate, 18));
    const suppliedTokens = cTokenBalance * exchangeRate;

    const suppliedUSD = pool.name === "ETH"
      ? suppliedTokens * ethPrice
      : suppliedTokens;

    const collateralUSD = suppliedUSD * (collateralFactor / 1e18);

    let borrowTokens = parseFloat(ethers.utils.formatUnits(borrow, pool.decimals));
    let borrowUSD = pool.name === "ETH"
      ? borrowTokens * ethPrice
      : borrowTokens;

    totalCollateral += collateralUSD;
    totalBorrow += borrowUSD;

    if (pool.name === "ETH") {
      ethCollateralUSD = collateralUSD;
      ethBorrowInETH = borrowTokens;
    }

    breakdown.push(`${pool.name}: 🟢 $${collateralUSD.toFixed(2)} (${suppliedTokens.toFixed(4)} ${pool.name}) | 🔴 $${borrowUSD.toFixed(2)}`);
  }

  const hf = totalBorrow === 0 ? "∞" : (totalCollateral / totalBorrow).toFixed(4);
  let liquidationEthPrice = null;

  if (ethCollateralUSD > 0 && ethBorrowInETH > 0) {
    const nonEthCollateral = totalCollateral - ethCollateralUSD;
    const nonEthBorrow = totalBorrow - (ethBorrowInETH * ethPrice);
    const criticalEthPrice = nonEthBorrow >= ethCollateralUSD
      ? 0
      : (ethCollateralUSD - nonEthBorrow) / ethBorrowInETH;
    liquidationEthPrice = criticalEthPrice;
  }

  return {
    hf,
    collateral: totalCollateral,
    borrow: totalBorrow,
    breakdown,
    liquidationEthPrice
  };
}
async function handleBotCommands() {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    const updates = res.data.result;

    if (!updates.length) return;

    for (const update of updates) {
      const message = update.message?.text?.trim();
      const userId = update.message?.chat?.id;

      if (!message || !userId) continue;

      if (!ACTIVE_CHAT_ID) ACTIVE_CHAT_ID = userId.toString();

      if (message === "/status") {
        let text = "📊 Ликвидность по пулам:\n";
        for (const pool of pools) {
          try {
            const cash = await getCash(pool);
            text += `${pool.name}: ${cash.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD\n`;
          } catch {
            text += `${pool.name}: ошибка получения данных\n`;
          }
        }
        await sendTelegramMessage(text, userId);

      } else if (message === "/hf") {
        const ethPrice = await getEthPrice();
        const { hf, collateral, borrow, breakdown, liquidationEthPrice } = await calculateHealthFactor();

        let text = `📉 Текущий Health Factor: ${hf}\n\n`;
        text += `💼 Общий залог: $${collateral.toFixed(2)}\n💣 Общий долг: $${borrow.toFixed(2)}\n\n`;
        for (const line of breakdown) text += `• ${line}\n`;
        text += `\n📈 Цена ETH: $${ethPrice.toFixed(2)}\n`;

        if (liquidationEthPrice) {
          text += `⚠️ Ликвидация при цене ETH ≈ $${liquidationEthPrice.toFixed(2)}`;
        } else {
          text += `✅ До ликвидации далеко`;
        }

        await sendTelegramMessage(text, userId);
      }
    }

    const lastUpdateId = updates[updates.length - 1].update_id;
    await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`);
  } catch (err) {
    console.error("❌ Ошибка при обработке команд:", err.message);
  }
}

function startLoops() {
  setInterval(() => handleBotCommands(), 8000);
  setInterval(() => checkLiquidity(), CHECK_INTERVAL_MS);
  setInterval(() => checkSelfHealth(), CHECK_INTERVAL_MS);

  handleBotCommands();
  checkLiquidity();
  checkSelfHealth();
}

async function checkSelfHealth() {
  const comptrollerAddress = "0xAB1c342C7bf5Ec5F02ADEA1c2270670bCa144CbB";
  const comptrollerAbi = ["function getAccountLiquidity(address) view returns (uint, uint, uint)"];
  const contract = new ethers.Contract(comptrollerAddress, comptrollerAbi, provider);

  try {
    const [error, liquidity, shortfall] = await contract.getAccountLiquidity(selfMonitor.address);

    if (!error.eq(0)) return;

    const hf = shortfall.gt(0) ? 0 : liquidity.eq(0) ? 1 : "∞";

    if (hf === 0 && selfMonitor.lastStatus !== "danger") {
      await sendTelegramMessage("⚠️ Твой Health Factor упал до 0.0! Возможна ликвидация!");
      selfMonitor.lastStatus = "danger";
    } else if (hf !== 0 && selfMonitor.lastStatus !== "safe") {
      await sendTelegramMessage(`✅ Health Factor восстановлен: ${hf}`);
      selfMonitor.lastStatus = "safe";
    }
  } catch (err) {
    console.error("❌ Ошибка self-monitoring:", err.message);
  }
}

startLoops();
