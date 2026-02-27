const fs = require("fs");
const { nowIso } = require("./utils/fs");

function createLogger(logFile) {
  function logLine(line) {
    try {
      fs.appendFileSync(logFile, `[${nowIso()}] ${line}\n`, "utf8");
    } catch {}
  }

  return {
    logLine,
  };
}

module.exports = {
  createLogger,
};

