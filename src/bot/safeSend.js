const { chunkText, sanitizeForTelegramCodeBlock } = require("../utils/text");

function createSafeSend(bot) {
  return async function safeSend(chatId, text) {
    const msg = sanitizeForTelegramCodeBlock(text);
    const chunks = chunkText(msg, 3500);

    for (const c of chunks) {
      if (!c) continue;
      try {
        await bot.sendMessage(chatId, "```text\n" + c + "\n```", { parse_mode: "Markdown" });
      } catch {
        await bot.sendMessage(chatId, c);
      }
    }
  };
}

module.exports = {
  createSafeSend,
};

