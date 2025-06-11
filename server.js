const ethers = require("ethers");
const axios = require("axios");
const fs = require("fs");
/
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

async function handleBotCommands() {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    const updates = res.data.result;

    if (!updates.length) return;

    const lastUpdate = updates[updates.length - 1];
    const message = lastUpdate.message?.text?.trim();
    const userId = lastUpdate.message?.chat?.id;

    if (!message || !userId) return;

    await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdate.update_id + 1}`);

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
    } // ←←← ДОБАВЬТЕ ЭТУ СКОБКУ

    // Остальной код должен быть вне блока /hf!
  } catch (err) {
    console.error("❌ Ошибка в handleBotCommands:", err);
  }
}

async function getEthPrice() {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    return res.data.ethereum.usd;
  } catch (e) {
    console.error("❌ Не удалось получить цену ETH:", e.message);
    return 0;
  }
}

async function calculateHealthFactor() {
  const ethPrice = await getEthPrice();

  const comptrollerAddress = "0xAB1c342C7bf5Ec5F02ADEA1c2270670bCa144CbB";
  const comptrollerAbi = ["function markets(address) view returns (bool, uint256, bool)"];
  const cTokenAbi = [
    "function balanceOf(address) view returns (uint256)",
    "function borrowBalanceStored(address) view returns (uint256)",
    "function exchangeRateStored() view returns (uint256)"
  ];

  const comptroller = new ethers.Contract(comptrollerAddress, comptrollerAbi, provider);
  const user = selfMonitor.address;
  const breakdown = [];

  let totalCollateral = 0;
  let totalBorrow = 0;
  let ethCollateral = 0;
  let ethBorrowAmount = 0;

  for (const pool of pools) {
    const cToken = new ethers.Contract(pool.address, cTokenAbi, provider);
    const [cBal, borrow, rate] = await Promise.all([
      cToken.balanceOf(user),
      cToken.borrowBalanceStored(user),
      cToken.exchangeRateStored()
    ]);

    const [, factor] = await comptroller.markets(pool.address);

    // Приводим к числам
    const cTokenBal = cBal; // raw BigNumber
    const exchangeRate = rate; // raw BigNumber

    // suppliedUnderlying = (cTokenBal * exchangeRate) / 10^(18 + 8 - pool.decimals)
    const suppliedUnderlying = cTokenBal
      .mul(exchangeRate)
      .div(ethers.BigNumber.from(10).pow(18 + 8 - pool.decimals));

    // Переводим в float для отображения
    const suppliedUnderlyingFloat = parseFloat(ethers.utils.formatUnits(suppliedUnderlying, pool.decimals));

    // suppliedUnderlying в underlying токене (например, ETH, USDC)
    const suppliedUSD = pool.name === "ETH"
      ? suppliedUnderlyingFloat * ethPrice
      : suppliedUnderlyingFloat;

    const collateralUSD = suppliedUSD * (factor / 1e18);

    // borrow всегда в underlying токене
    const borrowAmount = parseFloat(ethers.utils.formatUnits(borrow, pool.decimals));
    const borrowUSD = pool.name === "ETH"
      ? borrowAmount * ethPrice
      : borrowAmount;

    totalCollateral += collateralUSD;
    totalBorrow += borrowUSD;

    if (pool.name === "ETH") {
      ethCollateral = collateralUSD;
      ethBorrowAmount = borrowAmount;
    }

    breakdown.push(
      `${pool.name}: 🟢 $${collateralUSD.toFixed(2)} (${suppliedUnderlyingFloat.toFixed(4)} ${pool.name}) | 🔴 $${borrowUSD.toFixed(2)}`
    );
  }

  const hf = totalBorrow === 0 ? "∞" : (totalCollateral / totalBorrow).toFixed(4);

  let liquidationEthPrice = null;
  if (ethCollateral > 0 && ethBorrowAmount > 0) {
    const nonEthCollateral = totalCollateral - ethCollateral;
    const nonEthBorrow = totalBorrow - ethBorrowAmount * ethPrice;
    liquidationEthPrice = (ethCollateral - nonEthBorrow) / ethBorrowAmount;
    if (liquidationEthPrice < 0) liquidationEthPrice = null;
  }

  return {
    hf,
    collateral: totalCollateral,
    borrow: totalBorrow,
    breakdown,
    liquidationEthPrice,
    ethPrice
  };
}

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
setInterval(handleBotCommands, 8000);
setInterval(checkSelfHealth, CHECK_INTERVAL_MS);

checkLiquidity();
handleBotCommands();
function checkSelfHealth() {
  // Пока функция не реализована, чтобы не было ошибки
}