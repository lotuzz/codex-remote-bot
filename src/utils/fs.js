const fs = require("fs");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  ensureDir,
  nowIso,
};

