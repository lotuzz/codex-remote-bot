const path = require("path");
const os = require("os");
const { ensureDir } = require("./utils/fs");
const { parseKeyValueList, toBool } = require("./utils/parsers");

function isWslRuntime() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

function loadConfig() {
  require("dotenv").config();

  const isWindows = process.platform === "win32";
  const isWsl = isWslRuntime();
  const homeDir = os.homedir();

  const defaultAssistantRoot = isWindows
    ? "D:\\Asistant"
    : isWsl
      ? path.join(homeDir, "asistant")
      : path.join(homeDir, "assistant");

  const assistantRoot = process.env.ASSISTANT_ROOT || defaultAssistantRoot;
  const opsDir = process.env.OPS_DIR || path.join(assistantRoot, "ops");
  const applicationsDir = process.env.APPLICATIONS_DIR || path.join(assistantRoot, "applications");

  ensureDir(opsDir);
  ensureDir(applicationsDir);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN belum diisi di .env");
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim();
  if (!ollamaBaseUrl) throw new Error("OLLAMA_BASE_URL belum diisi di .env");

  const defaultCodexConfigPath = path.join(homeDir, ".codex", "config.toml");

  return {
    token,
    assistantRoot,
    opsDir,
    applicationsDir,
    logFile: path.join(opsDir, "telegram-agent.log"),
    codexConfigPath: process.env.CODEX_CONFIG_PATH || defaultCodexConfigPath,
    allowedChatIds: new Set(
      (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
    workspaceMap: parseKeyValueList(process.env.CODEX_WORKSPACES),
    repoMap: parseKeyValueList(process.env.GIT_REPOS),
    allowNetworkTasks: toBool(process.env.ALLOW_NETWORK_TASKS, false),
    ollamaBaseUrl,
    ollamaRequestTimeoutMs: Number.parseInt(process.env.OLLAMA_REQUEST_TIMEOUT_MS || "", 10) || 10 * 60 * 1000,
  };
}

module.exports = {
  loadConfig,
};
