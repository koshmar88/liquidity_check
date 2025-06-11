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
  { name: "DAI",  address: "0x8e595470Ed749b85C6F7669de83EAe304C2ec68F", decimals: 18 },
  { name: "ETH",  address: "0x41c84c0e2EE0b740Cf0d31F63f3B6F627DC6b393", decimals: 18 }
];

// Пример для Compound (замените адреса на актуальные для вашей сети)
const compoundPools = [
  { name: "USDT",   address: "0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9", decimals: 8, underlyingDecimals: 6 }, // cUSDT
  { name: "ETH",    address: "0x4Dd26482738bE6C06C31467a19dcdA9AD781e8C4", decimals: 8, underlyingDecimals: 18 }, // cETH (WETH market)
  { name: "wstETH", address: "0x041171993284df560249B57358F931D9eB7b925D", decimals: 8, underlyingDecimals: 18 }, // cWSTETH
  { name: "WBTC",   address: "0xccF4429DB6322D5C611ee964527D42E5d685DD6a", decimals: 8, underlyingDecimals: 8 }   // cWBTC
];

const aavePools = [
  {
    name: "USDT",
    aToken: "0x3Ed3B47Dd13EC9a98b44e6204A523E766B225811",
    variableDebtToken: "0x619beb58998eD2278e08620f97007e1116D5D25b",
    decimals: 6
  },
  {
    name: "ETH",
    aToken: "0x3a3A65aAb0dd2A17E3F1947bA16138cd37d08c04",
    variableDebtToken: "0xF63B34710400CAd3e044cFfDcAb00a0f32E33eCf", // проверьте по getReserveTokensAddresses
    decimals: 18
  }
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
      const results = await calculateAllHealthFactors();
      let text = "";
      for (const res of results) {
        text += `\n=== ${res.protocol} ===\n`;
        text += `📉 Health Factor: ${res.hf}\n💼 Залог: $${res.collateral.toFixed(2)}\n💣 Долг: $${res.borrow.toFixed(2)}\n💰 Портфель: $${res.portfolio.toFixed(2)}\n`;
        for (const line of res.breakdown) {
          text += `• ${line}\n`;
        }
        if (res.liquidationEthPrice) {
          text += `⚠️ Ликвидация при цене ETH ≈ $${res.liquidationEthPrice.toFixed(2)}\n`;
        }
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
  let wbtcPrice = null;
  let wstethPrice = null;
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
      ethBorrow = borrowed;
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
    let totalSuppliedUSD = 0; // сумма всех вложений без CF

    if (suppliedUSD > 0) {
      totalSuppliedUSD += suppliedUSD; // без CF!
      totalCollateralUSD += suppliedUSD * collateralFactor; // с CF
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
  let portfolio = totalSuppliedUSD - totalBorrowUSD;

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

async function calculateIronBank() {
  let totalCollateralUSD = 0;
  let totalBorrowUSD = 0;
  let ethBorrow = 0;
  let ethPrice = await getEthPrice();
  let wbtcPrice = null;
  let wstethPrice = null;
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
    let exchangeRateScale = 18;
    if (exchangeRate.lt(ethers.BigNumber.from("1000000000000"))) {
      exchangeRateScale = 8;
    }
    const suppliedUnderlying = cBal.mul(exchangeRate).div(ethers.BigNumber.from(10).pow(exchangeRateScale));
    const supplied = parseFloat(ethers.utils.formatUnits(suppliedUnderlying, pool.decimals));
    const borrowed = parseFloat(ethers.utils.formatUnits(borrow, pool.decimals));
    let suppliedUSD = supplied;
    let borrowedUSD = borrowed;
    if (pool.name === "ETH") {
      suppliedUSD = supplied * ethPrice;
      borrowedUSD = borrowed * ethPrice;
      ethBorrow = borrowed;
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
    if (suppliedUSD > 0) {
      totalCollateralUSD += suppliedUSD * collateralFactor;
      breakdown.push(`${pool.name}: 🟢 $${suppliedUSD.toFixed(2)} (${supplied.toFixed(4)} ${pool.name}) × CF ${collateralFactor}`);
    }
    if (borrowedUSD > 0) {
      totalBorrowUSD += borrowedUSD;
      breakdown.push(`${pool.name}: 🔴 $${borrowedUSD.toFixed(2)} (${borrowed.toFixed(4)} ${pool.name})`);
    }
  }
  let hf = totalBorrowUSD > 0 ? totalCollateralUSD / totalBorrowUSD : 0;
  let portfolio = totalCollateralUSD - totalBorrowUSD;
  let liquidationEthPrice = null;
  if (ethBorrow > 0) {
    liquidationEthPrice = totalCollateralUSD / ethBorrow;
  }
  return {
    protocol: "Iron Bank",
    hf: hf.toFixed(4),
    collateral: totalCollateralUSD,
    borrow: totalBorrowUSD,
    portfolio,
    breakdown,
    liquidationEthPrice,
    ethPrice
  };
}

// Аналогично реализуйте для Compound и Aave (пример для Compound ниже)
async function getCompoundCollateralFactor(cTokenAddress) {
  // Используйте свой Compound Comptroller и ABI
  const compoundComptrollerAddress = "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B";
  const compoundComptroller = new ethers.Contract(compoundComptrollerAddress, comptrollerAbi, provider);
  const market = await compoundComptroller.markets(cTokenAddress);
  return Number(ethers.utils.formatUnits(market.collateralFactorMantissa, 18));
}

async function calculateCompound() {
  let totalCollateralUSD = 0;
  let totalBorrowUSD = 0;
  let ethPrice = await getEthPrice();
  let wbtcPrice = null;
  let wstethPrice = null;
  let breakdown = [];
  for (const pool of compoundPools) {
    const cToken = new ethers.Contract(pool.address, cTokenAbi, provider);
    const [cBal, borrow, exchangeRate, collateralFactor] = await Promise.all([
      cToken.balanceOf(userAddress),
      cToken.borrowBalanceStored(userAddress),
      cToken.exchangeRateStored(),
      getCompoundCollateralFactor(pool.address)
    ]);
    const suppliedUnderlying = cBal.mul(exchangeRate).div(ethers.BigNumber.from(10).pow(18 + 8 - pool.underlyingDecimals));
    const supplied = parseFloat(ethers.utils.formatUnits(suppliedUnderlying, pool.underlyingDecimals));
    const borrowed = parseFloat(ethers.utils.formatUnits(borrow, pool.underlyingDecimals));
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
    if (suppliedUSD > 0) {
      totalCollateralUSD += suppliedUSD * collateralFactor;
      breakdown.push(`${pool.name}: 🟢 $${suppliedUSD.toFixed(2)} (${supplied.toFixed(4)} ${pool.name}) × CF ${collateralFactor}`);
    }
    if (borrowedUSD > 0) {
      totalBorrowUSD += borrowedUSD;
      breakdown.push(`${pool.name}: 🔴 $${borrowedUSD.toFixed(2)} (${borrowed.toFixed(4)} ${pool.name})`);
    }
  }
  let hf = totalBorrowUSD > 0 ? totalCollateralUSD / totalBorrowUSD : 0;
  let portfolio = totalCollateralUSD - totalBorrowUSD;
  return {
    protocol: "Compound",
    hf: hf.toFixed(4),
    collateral: totalCollateralUSD,
    borrow: totalBorrowUSD,
    portfolio,
    breakdown
  };
}

// Для Aave используйте аналогичную структуру (свою функцию расчёта supply/borrow/collateralFactor)
async function calculateAave() {
  let totalCollateralUSD = 0;
  let totalBorrowUSD = 0;
  let totalSuppliedUSD = 0;
  let ethPrice = await getEthPrice();
  let breakdown = [];

  for (const pool of aavePools) {
    const { supplied, borrowed } = await getAavePosition(pool);
    let suppliedUSD = supplied;
    let borrowedUSD = 0;

    if (pool.name === "ETH") {
      suppliedUSD = supplied * ethPrice;
      // borrowedUSD = 0; // не учитываем borrow
    } else if (pool.name === "USDT") {
      borrowedUSD = borrowed; // только для USDT
    }

    if (suppliedUSD > 0) {
      totalSuppliedUSD += suppliedUSD;
      // В Aave CF обычно 0.8 для USDT/ETH, если нужно — получите из протокола
      const collateralFactor = pool.name === "USDT" ? 0.8 : 0.8;
      totalCollateralUSD += suppliedUSD * collateralFactor;
      breakdown.push(`${pool.name}: 🟢 $${suppliedUSD.toFixed(2)} (${supplied.toFixed(4)} ${pool.name}) × CF ${collateralFactor}`);
    }
    if (borrowedUSD > 0) {
      totalBorrowUSD += borrowedUSD;
      breakdown.push(`${pool.name}: 🔴 $${borrowedUSD.toFixed(2)} (${borrowed.toFixed(4)} ${pool.name})`);
    }
  }

  let hf = totalBorrowUSD > 0 ? totalCollateralUSD / totalBorrowUSD : 0;
  let portfolio = totalSuppliedUSD - totalBorrowUSD;

  return {
    protocol: "Aave",
    hf: hf.toFixed(4),
    collateral: totalCollateralUSD,
    borrow: totalBorrowUSD,
    portfolio,
    breakdown
  };
}

// Итоговая функция
async function calculateAllHealthFactors() {
  const iron = await calculateIronBank();
  const compound = await calculateCompound();
  const aave = await calculateAave();
  return [iron, compound, aave];
}

// Для Compound
async function getCompoundPosition(pool) {
  const cToken = new ethers.Contract(pool.address, cTokenAbi, provider);
  let supplied = 0, borrowed = 0;
  try {
    const [cBal, borrow, exchangeRate] = await Promise.all([
      cToken.balanceOf(userAddress),
      cToken.borrowBalanceStored(userAddress),
      cToken.exchangeRateStored()
    ]);
    const suppliedUnderlying = cBal.mul(exchangeRate).div(ethers.BigNumber.from(10).pow(18 + 8 - pool.underlyingDecimals));
    supplied = parseFloat(ethers.utils.formatUnits(suppliedUnderlying, pool.underlyingDecimals));
    borrowed = parseFloat(ethers.utils.formatUnits(borrow, pool.underlyingDecimals));
  } catch (e) {
    // Если borrowBalanceStored revert — просто оставляем borrowed = 0
    console.warn(`⚠️ Не удалось получить borrow для ${pool.name}:`, e.message);
  }
  return { supplied, borrowed };
}

// Для Aave
async function getAavePosition(pool) {
  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)"
  ];
  const aToken = new ethers.Contract(pool.aToken, erc20Abi, provider);
  let supplied = 0, borrowed = 0;
  try {
    const suppliedRaw = await aToken.balanceOf(userAddress);
    supplied = parseFloat(ethers.utils.formatUnits(suppliedRaw, pool.decimals));
  } catch (e) {
    console.warn(`⚠️ Не удалось получить supply для ${pool.name}:`, e.message);
  }
  try {
    const debtToken = new ethers.Contract(pool.variableDebtToken, erc20Abi, provider);
    const borrowedRaw = await debtToken.balanceOf(userAddress);
    borrowed = parseFloat(ethers.utils.formatUnits(borrowedRaw, pool.decimals));
  } catch (e) {
    // Если variableDebtToken не существует — просто оставляем borrowed = 0
    console.warn(`⚠️ Не удалось получить borrow для ${pool.name}:`, e.message);
  }
  return { supplied, borrowed };
}