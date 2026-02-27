const { chunkText, sanitizeForTelegramCodeBlock } = require("../utils/text");

function chunkHtmlByLines(html, maxLen = 3500) {
  const text = String(html || "");
  if (text.length <= maxLen) return [text];

  const lines = text.split(/\r?\n/);
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current ? current + "\n" + line : line;
    if (next.length <= maxLen) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (line.length <= maxLen) {
      current = line;
      continue;
    }

    const longParts = chunkText(line, maxLen);
    for (let i = 0; i < longParts.length - 1; i++) {
      chunks.push(longParts[i]);
    }
    current = longParts[longParts.length - 1] || "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [""];
}

function createSafeSend(bot) {
  return async function safeSend(chatId, text, options = {}) {
    const mode = options.mode || "code";

    if (mode === "html") {
      const html = String(text || "");
      const chunks = chunkHtmlByLines(html, 3500);

      for (const c of chunks) {
        if (!c) continue;
        try {
          await bot.sendMessage(chatId, c, { parse_mode: "HTML" });
        } catch {
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
