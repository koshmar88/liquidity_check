const ethers = require("ethers");
const axios = require("axios");
const fs = require("fs");
const express = require("express");

const app = express();
app.use(express.json());

const selfMonitor = {
  address: "0x2a4cE5BaCcB98E5F95D37F8B3D1065754E0389CD",
  lastStatus: "safe"
};

// === 🔐 Конфигурация из переменных окружения ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const RPC_URL = process.env.RPC_URL;
const STATIC_CHAT_ID = process.env.STATIC_CHAT_ID?.trim();
const THRESHOLD_USD = parseFloat(process.env.THRESHOLD_USD || "1000");
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "60000");

if (!BOT_TOKEN || !RPC_URL) {
  console.error("❌ Отсутствует BOT_TOKEN или RPC_URL в окружении.");
  process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
let ACTIVE_CHAT_ID = STATIC_CHAT_ID || null;

if (ACTIVE_CHAT_ID) {
  console.log("✅ Загружен chat_id из STATIC_CHAT_ID:", ACTIVE_CHAT_ID);
} else {
  console.log("⚠️ chat_id не найден, бот пока не знает, кому слать уведомления.");
}

const ironBankPools = [
  { name: "USDT", address: "0x48759F220ED983dB51fA7A8C0D2AAb8f3ce4166a", decimals: 6 },
  { name: "USDC", address: "0x76Eb2FE28b36B3ee97F3Adae0C69606eeDB2A37c", decimals: 6 },
  { name: "DAI", address: "0x8e595470Ed749b85C6F7669de83EAe304C2ec68F", decimals: 18 },
  { name: "ETH", address: "0x41c84c0e2EE0b740Cf0d31F63f3B6F627DC6b393", decimals: 18 }
];

// Пример для Compound (замените адреса на актуальные для вашей сети)
const compoundPools = [
  { name: "USDT", address: "0xf650C3d88Cc8617A7bD0D0d6fA41a6C7eCfC3bC1", decimals: 8, underlyingDecimals: 6 },
  { name: "USDC", address: "0x39AA39c021dfbaE8faC545936693aC917d5E7563", decimals: 8, underlyingDecimals: 6 },
  { name: "DAI", address: "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643", decimals: 8, underlyingDecimals: 18 },
  { name: "ETH", address: "0x4Dd26482738bE6C06C31467a19dcdA9AD781e8C4", decimals: 8, underlyingDecimals: 18 },
  { name: "wstETH", address: "0x041171993284df560249B57358F931D9eB7b925D", decimals: 8, underlyingDecimals: 18 },
  { name: "WBTC", address: "0x2263B9A0fD6A2633A2F6a5cAaA0dA3aE3C5A6cA5", decimals: 8, underlyingDecimals: 8 }
];

// Пример для Aave v2 (замените адреса на актуальные aToken и debtToken)
const aavePools = [
  { name: "USDT", aToken: "0x3Ed3B47Dd13EC9a98b44e6204A523E766B225811", variableDebtToken: "0x619beb58998eD2278e08620f97007e1116D5D25b", decimals: 6 },
  { name: "USDC", aToken: "0xBcca60bB61934080951369a648Fb03DF4F96263C", variableDebtToken: "0x619beb58998eD2278e08620f97007e1116D5D25b", decimals: 6 },
  { name: "DAI", aToken: "0x028171bCA77440897B824Ca71D1c56E803B653a9", variableDebtToken: "0x6C3e4cb2E96B01F4b866965A91ed4437839A121a", decimals: 18 },
  { name: "ETH", aToken: "0xd01607c3C5eCABa394D8be377a08590149325722", variableDebtToken: "0x77ca01483f379E58174739308945f044e1a764dc", decimals: 18 }
];

const lastCashValues = {};

async function getCash(pool) {
  const cToken = new ethers.Contract(pool.address, ["function getCash() view returns (uint256)"], provider);
  const rawCash = await cToken.getCash();
  return parseFloat(ethers.utils.formatUnits(rawCash, pool.decimals));
}

async function sendTelegramMessage(text, chatId = ACTIVE_CHAT_ID) {
  if (!chatId) {
    console.warn("⚠️ Нет chat_id, пропуск отправки:", text);
    return;
  }

  console.log("📬 Отправка в Telegram →", chatId, "|", text);
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error("❌ Ошибка отправки сообщения:", err.response?.data || err.message);
  }
}

async function checkLiquidity() {
  console.log("🔍 Проверка ликвидности...");

  for (const pool of ironBankPools) {
    try {
      const currentCash = await getCash(pool);
      const prev = lastCashValues[pool.name];

      if (prev !== undefined) {
        const diff = currentCash - prev;
        if (Math.abs(diff) >= THRESHOLD_USD) {
          const direction = diff > 0 ? "добавлена" : "изъята";
          const message = `💧 В пуле ${pool.name} ${direction} ликвидность: ${diff.toFixed(2)} USD`;
          console.log(message);
          await sendTelegramMessage(message);
        }
      }

      lastCashValues[pool.name] = currentCash;
    } catch (err) {
      console.error(`⚠️ Ошибка обработки пула ${pool.name}:`, err.message);
    }
  }
}

app.post("/webhook", async (req, res) => {
  const update = req.body;
  const message = update.message?.text?.trim();
  const userId = update.message?.chat?.id;

  if (!message || !userId) return res.sendStatus(200);

  if (!ACTIVE_CHAT_ID) {
    ACTIVE_CHAT_ID = userId.toString();
    console.log("💾 chat_id сохранён:", ACTIVE_CHAT_ID);
  }

  if (message === "/status") {
    let text = "📊 Ликвидность по пулам:\n";
    for (const pool of ironBankPools) {
      try {
        const cash = await getCash(pool);
        text += `${pool.name}: ${cash.toLocaleString(undefined, { maximumFractionDigits: 2 })} USD\n`;
      } catch {
        text += `${pool.name}: ошибка получения данных\n`;
      }
    }
    await sendTelegramMessage(text, userId);
  } else if (message === "/start") {
    await sendTelegramMessage("👋 Привет! Я буду уведомлять тебя о резких изменениях ликвидности. Используй команду /status для проверки.", userId);
  } else if (message === "/hf") {
    try {
      const { hf, collateral, borrow, portfolio, breakdown, liquidationEthPrice, ethPrice } = await calculateHealthFactor();

      let text = `📉 Текущий Health Factor: ${hf}\n\n`;
      text += `💼 Общий залог: $${collateral.toFixed(2)}\n💣 Общий долг: $${borrow.toFixed(2)}\n`;
      text += `💰 Портфель: $${portfolio.toFixed(2)}\n\n`;

      for (const line of breakdown) {
        text += `• ${line}\n`;
      }

      text += `\n📈 Цена ETH: $${ethPrice.toFixed(2)}\n`;

      if (liquidationEthPrice) {
        text += `⚠️ Ликвидация при цене ETH ≈ $${liquidationEthPrice.toFixed(2)}`;
      } else {
        text += `✅ До ликвидации далеко`;
      }

      await sendTelegramMessage(text, userId);
    } catch (err) {
      console.error("❌ Ошибка в calculateHealthFactor:", err);
      await sendTelegramMessage("❌ Ошибка при расчёте Health Factor. Проверьте логи сервера.", userId);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Express server started on port", PORT);
});

// Тест подключения к сети
(async () => {
  try {
    const block = await provider.getBlockNumber();
    console.log("✅ Сеть работает, текущий блок:", block);
  } catch (e) {
    console.error("❌ Ошибка подключения к сети:", e.message);
  }
})();

// Запуск циклов
setInterval(checkLiquidity, CHECK_INTERVAL_MS);
setInterval(checkSelfHealth, CHECK_INTERVAL_MS);

checkLiquidity();
function checkSelfHealth() {
  // Пока функция не реализована, чтобы не было ошибки
}

const cTokenAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function borrowBalanceStored(address) view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function decimals() view returns (uint8)"
];
const userAddress = selfMonitor.address;

// Кэш для цены ETH
let cachedEthPrice = null;
let lastEthPriceUpdate = 0;
const ETH_PRICE_CACHE_MS = 60_000; // 1 минута

async function getEthPrice() {
  const now = Date.now();
  if (cachedEthPrice && now - lastEthPriceUpdate < ETH_PRICE_CACHE_MS) {
    return cachedEthPrice;
  }
  // Получаем цену ETH через Binance API
  const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT");
  cachedEthPrice = parseFloat(data.price);
  lastEthPriceUpdate = now;
  return cachedEthPrice;
}

const comptrollerAddress = "0xAB1c342C7bf5Ec5F02ADEA1c2270670bCa144CbB";
const comptrollerAbi = [
  "function markets(address cToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isComped)"
];
const comptroller = new ethers.Contract(comptrollerAddress, comptrollerAbi, provider);

async function getCollateralFactor(cTokenAddress) {
  const market = await comptroller.markets(cTokenAddress);
  // collateralFactorMantissa обычно с 18 знаками (например, 800000000000000000 = 0.8)
  return Number(ethers.utils.formatUnits(market.collateralFactorMantissa, 18));
}

async function calculateHealthFactor() {
  let totalCollateralUSD = 0;
  let totalBorrowUSD = 0;
  let ethBorrow = 0;
  let ethPrice = await getEthPrice();
  let breakdown = [];

  for (const pool of ironBankPools) {
    const cToken = new ethers.Contract(pool.address, cTokenAbi, provider);

    const [cBal, borrow, exchangeRate, cTokenDecimals, collateralFactor] = await Promise.all([
      cToken.balanceOf(userAddress),
      cToken.borrowBalanceStored(userAddress),
      cToken.exchangeRateStored(),
      cToken.decimals(),
      getCollateralFactor(pool.address)
    ]);

    // Определяем scale для exchangeRate (18 или 8)
    let exchangeRateScale = 18;
    if (exchangeRate.lt(ethers.BigNumber.from("1000000000000"))) {
      exchangeRateScale = 8;
    }

    const suppliedUnderlying = cBal
      .mul(exchangeRate)
      .div(ethers.BigNumber.from(10).pow(exchangeRateScale));

    const supplied = parseFloat(ethers.utils.formatUnits(suppliedUnderlying, pool.decimals));
    const borrowed = parseFloat(ethers.utils.formatUnits(borrow, pool.decimals));

    let suppliedUSD = supplied;
    let borrowedUSD = borrowed;

    if (pool.name === "ETH") {
      suppliedUSD = supplied * ethPrice;
      borrowedUSD = borrowed * ethPrice;
    }
    if (pool.name === "WBTC") {
      if (!wbtcPrice) wbtcPrice = await getWbtcPrice();
      suppliedUSD = supplied * wbtcPrice;
      borrowedUSD = borrowed * wbtcPrice;
    }
    if (pool.name === "wstETH") {
      if (!wstethPrice) wstethPrice = await getWstethPrice();
      suppliedUSD = supplied * wstethPrice;
      borrowedUSD = borrowed * wstethPrice;
    }

    // Считаем supply для всех активов с collateral factor
    if (suppliedUSD > 0) {
      totalCollateralUSD += suppliedUSD * collateralFactor;
      breakdown.push(`${pool.name}: 🟢 $${suppliedUSD.toFixed(2)} (${supplied.toFixed(4)} ${pool.name}) × CF ${collateralFactor}`);
    }

    // Считаем долг для всех пулов (ETH и стейблы)
    if (borrowedUSD > 0) {
      totalBorrowUSD += borrowedUSD;
      breakdown.push(`${pool.name}: 🔴 $${borrowedUSD.toFixed(2)} (${borrowed.toFixed(4)} ${pool.name})`);
    }
  }

  // Health Factor = totalCollateralUSD / totalBorrowUSD
  let hf = totalBorrowUSD > 0 ? totalCollateralUSD / totalBorrowUSD : 0;

  // Цена ETH для ликвидации (грубо: когда collateral == borrow)
  let liquidationEthPrice = null;
  if (ethBorrow > 0) {
    liquidationEthPrice = totalCollateralUSD / ethBorrow;
  }

  // Новый расчёт портфеля
  let portfolio = totalCollateralUSD - totalBorrowUSD;

  return {
    hf: hf.toFixed(4),
    collateral: totalCollateralUSD,
    borrow: totalBorrowUSD,
    portfolio,
    breakdown,
    liquidationEthPrice,
    ethPrice
  };
}

async function getWbtcPrice() {
  const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
  return parseFloat(data.price);
}

async function getWstethPrice() {
  // Можно взять с CoinGecko или другого источника
  const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=staked-ether&vs_currencies=usd");
  return data["staked-ether"].usd;
}