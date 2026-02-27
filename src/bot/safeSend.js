const { chunkText, sanitizeForTelegramCodeBlock } = require("../utils/text");

function createSafeSend(bot) {
  return async function safeSend(chatId, text, options = {}) {
    const mode = options.mode || "code";

    if (mode === "html") {
      const html = String(text || "");
      try {
        await bot.sendMessage(chatId, html, { parse_mode: "HTML" });
      } catch {
        const chunks = chunkText(html, 3500);
        for (const c of chunks) {
          if (!c) continue;
          await bot.sendMessage(chatId, c);
        }
      }
      return;
    }

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
