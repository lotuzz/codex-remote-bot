function chunkText(text, maxLen = 3500) {
  const t = text || "";
  if (t.length <= maxLen) return [t];
  const chunks = [];
  for (let i = 0; i < t.length; i += maxLen) {
    chunks.push(t.slice(i, i + maxLen));
  }
  return chunks;
}

function sanitizeForTelegramCodeBlock(text) {
  return (text || "").replace(/```/g, "``\\`");
}

module.exports = {
  chunkText,
  sanitizeForTelegramCodeBlock,
};

