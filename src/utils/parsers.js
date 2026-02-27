function parseKeyValueList(input) {
  // key=val;key2=val2
  const out = {};
  const str = (input || "").trim();
  if (!str) return out;

  for (const seg of str.split(";")) {
    const s = seg.trim();
    if (!s) continue;
    const idx = s.indexOf("=");
    if (idx <= 0) continue;
    const k = s.slice(0, idx).trim();
    const v = s.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }

  return out;
}

function toBool(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).toLowerCase().trim();
  return ["1", "true", "yes", "y", "on"].includes(s);
}

function parsePipeCommand(body) {
  // <alias> | <prompt>
  const idx = body.indexOf("|");
  if (idx === -1) return null;
  const alias = body.slice(0, idx).trim();
  const prompt = body.slice(idx + 1).trim();
  if (!alias || !prompt) return null;
  return { alias, prompt };
}

function parseSecondToken(text) {
  const parts = text.split(/\s+/, 2);
  return parts[1];
}

module.exports = {
  parseKeyValueList,
  toBool,
  parsePipeCommand,
  parseSecondToken,
};

