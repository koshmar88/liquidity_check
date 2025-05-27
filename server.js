const ethers = require("ethers");
const axios = require("axios");

// Telegram config
const BOT_TOKEN = "7957204455:AAEzvFeEQdyMejrGx87YJHkPPWPJpYsDj-g";
let ACTIVE_CHAT_ID = null; // будет установлен после /start или /status

const THRESHOLD_USD = 1000;
const CHECK_INTERVAL_MS = 60_000;

const pools = [
  { name: "USDT", address: "0x48759F220ED983dB51fA7A8C0D2AAb8f3ce4166a", decimals: 6 },
  { name: "USDC", address: "0x76Eb2FE28b36B3ee97F3Adae0C69606eeDB2A37c", decimals: 6 },
  { name: "DAI", address: "0x8e595470Ed749b85C6F7669de83EAe304C2ec68F", decimals: 18 },
];

const provider = new ethers.providers.JsonRpcProvider(
  "https://eth-mainnet.g.alchemy.com/v2/7QH7n3H4DakNuBQsKL8IcLRHDTGzG_oJ"
);

console.log("🔌 Подключение к RPC:", provider.connection.url);

const lastCashValues = {};

async function getCash(pool) {
  const cToken = new ethers.Contract(pool.address, ["function getCash() view returns (uint256)"], provider);
  const rawCash = await cToken.getCash();
  return parseFloat(ethers.utils.formatUnits(rawCash, pool.decimals));
}

async function sendTelegramMessage(text, chatId = ACTIVE_CHAT_ID) {
  console.log("📬 Отправка в Telegram →", chatId, "|", text);

  if (!chatId) {
    console.warn("⚠️ Нет активного chat_id, сообщение не отправлено.");
    return;
  }

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

    // Сохраняем активный chat_id
    ACTIVE_CHAT_ID = userId;

    // Отмечаем update как обработанный
    await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdate.update_id + 1}`);

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
      await sendTelegramMessage("Привет! Я буду уведомлять тебя о крупной ликвидности.\nКоманда: /status", userId);
    }
  } catch (err) {
    console.error("❌ Ошибка при обработке команд:", err.response?.data || err.message);
  }
}

// ⏱ Запуск циклов
setInterval(checkLiquidity, CHECK_INTERVAL_MS);
setInterval(handleBotCommands, 8000);

// Первый вызов
setTimeout(() => {
  checkLiquidity();
  handleBotCommands();
}, 3000);
