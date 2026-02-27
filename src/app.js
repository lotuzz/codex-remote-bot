const TelegramBot = require("node-telegram-bot-api");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { ensureDir } = require("./utils/fs");
const { createSafeSend } = require("./bot/safeSend");
const { createCommandRouter } = require("./bot/commandRouter");
const { createProcessService } = require("./services/processService");
const { createWorkspaceService } = require("./services/workspaceService");
const { createCodexService } = require("./services/codexService");
const { createSysService } = require("./services/sysService");
const { createDockerService } = require("./services/dockerService");

function startApp() {
  const config = loadConfig();
  const { logLine } = createLogger(config.logFile);
  const { runCmd } = createProcessService({ logLine });

  const workspaceService = createWorkspaceService({
    workspaceMap: config.workspaceMap,
    applicationsDir: config.applicationsDir,
    logLine,
  });

  const codexService = createCodexService({
    codexConfigPath: config.codexConfigPath,
    runCmd,
    ensureDir,
    logLine,
  });

  const sysService = createSysService({
    runCmd,
    resolveWorkspace: workspaceService.resolveWorkspace,
  });
  const dockerService = createDockerService({
    runCmd,
    logLine,
  });

  const bot = new TelegramBot(config.token, { polling: true });
  const safeSend = createSafeSend(bot);

  bot.on("polling_error", (err) => {
    logLine(`polling_error: ${err?.message || String(err)}`);
  });

  createCommandRouter({
    bot,
    safeSend,
    config,
    logLine,
    runCmd,
    workspaceService,
    codexService,
    sysService,
    dockerService,
  });

  console.log("Telegram agent running (polling)...");
  logLine("Bot started.");
}

module.exports = {
  startApp,
};
