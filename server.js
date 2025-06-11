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

const pools = [
  { name: "USDT", address: "0x48759F220ED983dB51fA7A8C0D2AAb8f3ce4166a", decimals: 6 },
  { name: "USDC", address: "0x76Eb2FE28b36B3ee97F3Adae0C69606eeDB2A37c", decimals: 6 },
  { name: "DAI", address: "0x8e595470Ed749b85C6F7669de83EAe304C2ec68F", decimals: 18 },
  { name: "ETH", address: "0x41c84c0e2EE0b740Cf0d31F63f3B6F627DC6b393", decimals: 18 }
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

  for (const pool of pools) {
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
    for (const pool of pools) {
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
      const { hf, collateral, borrow, breakdown, liquidationEthPrice, ethPrice } = await calculateHealthFactor();

      let text = `📉 Текущий Health Factor: ${hf}\n\n`;
      text += `💼 Общий залог: $${collateral.toFixed(2)}\n💣 Общий долг: $${borrow.toFixed(2)}\n\n`;

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

async function getEthPrice() {
  // Можно заменить на свой источник, если нужно
  const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  return data.ethereum.usd;
}

async function calculateHealthFactor() {
  let totalCollateralUSD = 0;
  let totalBorrowUSD = 0;
  let ethBorrow = 0;
  let ethPrice = await getEthPrice();
  let breakdown = [];

  for (const pool of pools) {
    const cToken = new ethers.Contract(pool.address, cTokenAbi, provider);

    // Получаем баланс cToken и borrow
    const [cBal, borrow, exchangeRate] = await Promise.all([
      cToken.balanceOf(userAddress),
      cToken.borrowBalanceStored(userAddress),
      cToken.exchangeRateStored()
    ]);

    // suppliedUnderlying = (cTokenBal * exchangeRate) / 10^(18 + 8 - pool.decimals)
    const suppliedUnderlying = cBal
      .mul(exchangeRate)
      .div(ethers.BigNumber.from(10).pow(18 + 8 - pool.decimals));
    const supplied = parseFloat(ethers.utils.formatUnits(suppliedUnderlying, pool.decimals));
    const borrowed = parseFloat(ethers.utils.formatUnits(borrow, pool.decimals));

    let suppliedUSD = supplied;
    let borrowedUSD = borrowed;

    if (pool.name === "ETH") {
      suppliedUSD = supplied * ethPrice;
      borrowedUSD = borrowed * ethPrice;
      ethBorrow = borrowed;
    }

    // Считаем только supply для стейблов и borrow только для ETH
    if (["USDT", "USDC", "DAI"].includes(pool.name)) {
      totalCollateralUSD += suppliedUSD;
      breakdown.push(`${pool.name}: 🟢 $${suppliedUSD.toFixed(2)} (${supplied.toFixed(4)} ${pool.name})`);
    }
    if (pool.name === "ETH") {
      totalBorrowUSD += borrowedUSD;
      breakdown.push(`${pool.name}: 🔴 $${borrowedUSD.toFixed(2)} (${borrowed.toFixed(4)} ETH)`);
    }
  }

  // Health Factor = totalCollateralUSD / totalBorrowUSD
  let hf = totalBorrowUSD > 0 ? totalCollateralUSD / totalBorrowUSD : 0;

  // Цена ETH для ликвидации (грубо: когда collateral == borrow)
  let liquidationEthPrice = null;
  if (ethBorrow > 0) {
    liquidationEthPrice = totalCollateralUSD / ethBorrow;
  }

  return {
    hf: hf.toFixed(4),
    collateral: totalCollateralUSD,
    borrow: totalBorrowUSD,
    breakdown,
    liquidationEthPrice,
    ethPrice
  };
}