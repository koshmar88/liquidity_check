const ethers = require("ethers");
const axios = require("axios");

// === 🔐 Конфигурация ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const RPC_URL = process.env.RPC_URL;
const STATIC_CHAT_ID = process.env.STATIC_CHAT_ID?.trim();
const THRESHOLD_USD = parseFloat(process.env.THRESHOLD_USD || "1000");
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "60000");

if (!BOT_TOKEN || !RPC_URL) {
  console.error("❌ BOT_TOKEN или RPC_URL не заданы");
  process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
let ACTIVE_CHAT_ID = STATIC_CHAT_ID || null;

if (ACTIVE_CHAT_ID) {
  console.log("✅ Загружен chat_id из STATIC_CHAT_ID:", ACTIVE_CHAT_ID);
} else {
  console.log("⚠️ chat_id не найден. Бот не сможет отправлять сообщения до /start");
}

const pools = [
  { name: "USDT", address: "0x48759F220ED983dB51fA7A8C0D2AAb8f3ce4166a", decimals: 6 },
  { name: "USDC", address: "0x76Eb2FE28b36B3ee97F3Adae0C69606eeDB2A37c", decimals: 6 },
  { name: "DAI",  address: "0x8e595470Ed749b85C6F7669de83EAe304C2ec68F", decimals: 18 },
];

const lastCashValues = {};

async function getCash(pool) {
  const cToken = new ethers.Contract(pool.address, ["function getCash() view returns (uint256)"], provider);
  const rawCash = await cToken.getCash();
  return parseFloat(ethers.utils.formatUnits(rawCash, pool.decimals));
}

async function sendTelegramMessage(text, chatId = ACTIVE_CHAT_ID) {
  if (!chatId) {
    console.warn("⚠️ Нет chat_id — сообщение не отправлено:", text);
    return;
  }

  console.log("📬 Отправка в Telegram →", chatId, "|", text);
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error("❌ Ошибка отправки:", err.response?.data || err.message);
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
      console.error(`⚠️ Ошибка пула ${pool.name}:`, err.message);
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
      console.log("💾 chat_id установлен из команды:", ACTIVE_CHAT_ID);
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
      await sendTelegramMessage("👋 Привет! Я буду уведомлять тебя о резких изменениях ликвидности.\nКоманда: /status", userId);
    }
  } catch (err) {
    if (err.response?.data?.error_code !== 409) {
      console.error("❌ Ошибка при команде:", err.response?.data || err.message);
    }
  }
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

// 👇 Старт с задержкой
setTimeout(() => {
  setInterval(checkLiquidity, CHECK_INTERVAL_MS);
  setInterval(handleBotCommands, 8000);
}, 3000);
