const crypto = require("crypto");
const { parsePipeCommand, parseSecondToken } = require("../utils/parsers");

function createCommandRouter({
  bot,
  safeSend,
  config,
  logLine,
  runCmd,
  workspaceService,
  codexService,
  sysService,
}) {
  let busy = false;
  const pending = new Map(); // code -> { chatId, kind, payload, createdAt }

  function isAllowed(chatId) {
    if (config.allowedChatIds.size === 0) return false;
    return config.allowedChatIds.has(String(chatId));
  }

  function codexHelpText() {
    return [
      "Codex commands:",
      "/codex",
      "/codex version",
      "/codex auth              (codex login status)",
      "/codex model             (lihat model aktif + config path)",
      "/codex set_model <model> (set model ke config.toml + bot)",
      "/codex models            (list model rekomendasi)",
      "/codex quota             (cara cek remaining limits)",
      "/codex usage_probe       (lihat token usage 1 run kecil via --json)",
    ].join("\n");
  }

  function formatRepoList() {
    return Object.entries(config.repoMap).map(([k, v]) => `- ${k} => ${v}`).join("\n") || "(optional: set GIT_REPOS di .env)";
  }

  function helpText() {
    return [
      "Telegram -> Server Agent",
      "",
      "Umum:",
      "/help",
      "/id",
      "/status",
      "/workspaces",
      "/pending",
      "",
      "Codex (coding):",
      "/ask <alias> | <prompt>          (sandbox: read-only)",
      "/run <alias> | <prompt>          (sandbox: workspace-write)",
      "/runnet <alias> | <prompt>       (workspace-write + network, jika diizinkan)",
      "",
      "Sys / Ops:",
      sysService.sysHelp(),
      "",
      codexHelpText(),
      "",
      "Workspaces:",
      workspaceService.formatWorkspaceList(),
      "",
      "Repos (for clone):",
      formatRepoList(),
      "",
      `Active model: ${codexService.getActiveModel() || "(default Codex recommended model)"}`,
      `Codex config: ${codexService.getConfigPath()}`,
      `ALLOW_NETWORK_TASKS=${config.allowNetworkTasks}`,
      `Log: ${config.logFile}`,
    ].join("\n");
  }

  function formatPendingList() {
    return (
      [...pending.entries()]
        .slice(0, 30)
        .map(([code, p]) => `- ${code} (${p.kind}, age=${Math.round((Date.now() - p.createdAt) / 1000)}s)`)
        .join("\n") || "(kosong)"
    );
  }

  function formatTaskResultMessage(res) {
    const header = res.ok ? `Selesai (exit ${res.code})` : `Error (exit ${res.code})`;
    return [header, "", "OUTPUT:", res.out || "(kosong)", "", "ERROR/LOG:", res.err || "(kosong)"].join("\n");
  }

  function makeConfirmCode() {
    return crypto.randomBytes(3).toString("hex");
  }

  async function enqueueWithConfirm(chatId, kind, payload, summaryLines) {
    const code = makeConfirmCode();
    pending.set(code, { chatId, kind, payload, createdAt: Date.now() });

    const msg = [
      "Konfirmasi diperlukan",
      ...summaryLines,
      `Kode: ${code}`,
      "",
      `Ketik /confirm ${code} untuk lanjut`,
      `atau /cancel ${code} untuk batal`,
    ].join("\n");

    await safeSend(chatId, msg);
  }

  async function executePendingItem(item) {
    if (item.kind === "sys") {
      const { task, arg1 } = item.payload;
      return sysService.execSysTask(task, arg1);
    }

    if (item.kind === "codex") {
      return codexService.execTask(item.payload);
    }

    if (item.kind === "codex_admin") {
      const { action, value } = item.payload;
      if (action === "set_model") {
        return codexService.setDefaultModel(value);
      }
      return { ok: false, code: 1, out: "", err: "Unknown codex_admin action" };
    }

    if (item.kind === "codex_usage_probe") {
      return codexService.usageProbe();
    }

    return { ok: false, code: 1, out: "", err: "Unknown task kind." };
  }

  async function handleBootstrapCommands(chatId, text) {
    if (text !== "/id") return false;

    await safeSend(chatId, `chat.id kamu: ${chatId}\nMasukkan ke TELEGRAM_ALLOWED_CHAT_IDS di .env lalu restart bot.`);
    return true;
  }

  async function handleBasicCommands(chatId, text) {
    if (text === "/start" || text === "/help") {
      await safeSend(chatId, helpText());
      return true;
    }

    if (text === "/status") {
      await safeSend(chatId, `Status: ${busy ? "BUSY" : "IDLE"}`);
      return true;
    }

    if (text === "/workspaces") {
      await safeSend(chatId, "Workspaces:\n" + workspaceService.formatWorkspaceList());
      return true;
    }

    if (text === "/pending") {
      await safeSend(chatId, "Pending confirmations:\n" + formatPendingList());
      return true;
    }

    return false;
  }

  async function handleApprovalCommands(chatId, text) {
    if (text.startsWith("/cancel ")) {
      const code = parseSecondToken(text);
      if (pending.has(code)) {
        pending.delete(code);
        await safeSend(chatId, `Task ${code} dibatalkan.`);
      } else {
        await safeSend(chatId, "Kode tidak ditemukan.");
      }
      return true;
    }

    if (!text.startsWith("/confirm ")) return false;

    const code = parseSecondToken(text);
    const item = pending.get(code);
    if (!item) {
      await safeSend(chatId, "Kode konfirmasi tidak ada/expired.");
      return true;
    }

    if (String(item.chatId) !== String(chatId)) {
      await safeSend(chatId, "Kode ini bukan untuk chat ini.");
      return true;
    }

    if (busy) {
      await safeSend(chatId, "Masih ada task lain berjalan.");
      return true;
    }

    pending.delete(code);
    busy = true;

    try {
      await safeSend(chatId, `Menjalankan task (${item.kind})...`);
      const res = await executePendingItem(item);
      logLine(`RESULT kind=${item.kind} ok=${res.ok} code=${res.code}`);
      await safeSend(chatId, formatTaskResultMessage(res));
    } finally {
      busy = false;
    }

    return true;
  }

  async function handleCodexManagementCommands(chatId, text) {
    if (text === "/codex" || text === "/codex help") {
      await safeSend(chatId, codexHelpText());
      return true;
    }

    if (text === "/codex version") {
      const res = await runCmd("codex", ["--version"]);
      await safeSend(chatId, res.ok ? res.out : res.out + "\n" + res.err);
      return true;
    }

    if (text === "/codex auth") {
      const res = await runCmd("codex", ["login", "status"]);
      const out = res.ok
        ? (res.out || res.err)
        : [res.out, res.err].filter(Boolean).join("\n");
      await safeSend(chatId, out || "(no output)");
      return true;
    }

    if (text === "/codex model") {
      const msgOut = [
        `Active model (bot): ${codexService.getActiveModel() || "(Codex default recommended model)"}`,
        `Config model: ${codexService.getConfigModel() || "(not set)"}`,
        `Config path: ${codexService.getConfigPath()}`,
        "",
        "Note: Codex CLI bisa override per-run dengan --model/-m.",
      ].join("\n");
      await safeSend(chatId, msgOut);
      return true;
    }

    if (text.startsWith("/codex set_model")) {
      const model = text.replace("/codex set_model", "").trim();
      if (!model) {
        await safeSend(chatId, "Usage: /codex set_model <model>\nContoh: /codex set_model gpt-5.3-codex");
        return true;
      }

      await enqueueWithConfirm(chatId, "codex_admin", { action: "set_model", value: model }, [
        "Kind: CODEX_ADMIN",
        "Action: set_model",
        `Model: ${model}`,
      ]);
      return true;
    }

    if (text === "/codex models") {
      const out = [
        "Recommended Codex models (examples):",
        "- gpt-5.3-codex",
        "- gpt-5.2-codex",
        "- gpt-5.2",
        "- gpt-5.1-codex-max",
        "- gpt-5.1",
        "",
        "Kamu bisa set default via `/codex set_model <model>` atau override per run dengan `--model/-m`.",
      ].join("\n");
      await safeSend(chatId, out);
      return true;
    }

    if (text === "/codex quota") {
      const out = [
        "Remaining limits / 'kuota' Codex:",
        "- Cara resmi: cek di Codex usage dashboard, atau buka Codex CLI interaktif lalu jalankan `/status`.",
        "",
        "Catatan:",
        "- Bot ini pakai `codex exec` (non-interactive), dan tidak ada perintah resmi untuk ambil 'remaining limits' langsung dari mode ini.",
        "- Kalau butuh angka token pemakaian per run, pakai: /codex usage_probe",
      ].join("\n");
      await safeSend(chatId, out);
      return true;
    }

    if (text === "/codex usage_probe") {
      await enqueueWithConfirm(chatId, "codex_usage_probe", {}, [
        "Kind: CODEX_USAGE_PROBE",
        "Action: run 1 tiny codex exec --json to read turn.completed.usage (tokens).",
        `Model: ${codexService.getActiveModel() || "(default)"}`,
        "Note: ini mengonsumsi sedikit kuota karena benar-benar menjalankan 1 request.",
      ]);
      return true;
    }

    return false;
  }

  async function handleSysCommands(chatId, text) {
    if (!text.startsWith("/sys")) return false;

    const parts = text.split(/\s+/);
    const task = parts[1];
    const arg1 = parts[2];

    if (!task) {
      await safeSend(chatId, sysService.sysHelp());
      return true;
    }

    await enqueueWithConfirm(chatId, "sys", { task, arg1 }, [
      "Kind: SYS",
      `Task: ${task}${arg1 ? " " + arg1 : ""}`,
    ]);
    return true;
  }

  async function enqueueCodexRun(chatId, parsed, options) {
    const wsPath = workspaceService.resolveWorkspace(parsed.alias);
    if (!wsPath) {
      await safeSend(chatId, `Workspace alias '${parsed.alias}' tidak ada. Cek /workspaces`);
      return;
    }

    await enqueueWithConfirm(chatId, "codex", {
      workspacePath: wsPath,
      sandboxMode: options.sandboxMode,
      prompt: parsed.prompt,
      enableNetwork: options.enableNetwork,
    }, [
      "Kind: CODEX",
      `Mode: ${options.modeLabel}`,
      `Workspace: ${parsed.alias}`,
      `Model: ${codexService.getActiveModel() || "(default)"}`,
    ]);
  }

  async function handleCodexRunCommands(chatId, text) {
    if (text.startsWith("/ask ")) {
      const parsed = parsePipeCommand(text.slice(5).trim());
      if (!parsed) {
        await safeSend(chatId, "Format: /ask <alias> | <prompt>");
        return true;
      }

      await enqueueCodexRun(chatId, parsed, {
        modeLabel: "ask (read-only)",
        sandboxMode: "read-only",
        enableNetwork: false,
      });
      return true;
    }

    if (text.startsWith("/run ")) {
      const parsed = parsePipeCommand(text.slice(5).trim());
      if (!parsed) {
        await safeSend(chatId, "Format: /run <alias> | <prompt>");
        return true;
      }

      await enqueueCodexRun(chatId, parsed, {
        modeLabel: "run (workspace-write)",
        sandboxMode: "workspace-write",
        enableNetwork: false,
      });
      return true;
    }

    if (text.startsWith("/runnet ")) {
      if (!config.allowNetworkTasks) {
        await safeSend(chatId, "runnet dimatikan (ALLOW_NETWORK_TASKS=false). Aktifkan di .env jika ingin.");
        return true;
      }

      const parsed = parsePipeCommand(text.slice(8).trim());
      if (!parsed) {
        await safeSend(chatId, "Format: /runnet <alias> | <prompt>");
        return true;
      }

      await enqueueCodexRun(chatId, parsed, {
        modeLabel: "runnet (workspace-write + network)",
        sandboxMode: "workspace-write",
        enableNetwork: true,
      });
      return true;
    }

    return false;
  }

  async function handleUnknownSlashCommand(chatId, text) {
    if (!text.startsWith("/")) return false;
    await safeSend(chatId, "Perintah tidak dikenal. Ketik /help");
    return true;
  }

  const authorizedMessageHandlers = [
    handleBasicCommands,
    handleApprovalCommands,
    handleCodexManagementCommands,
    handleSysCommands,
    handleCodexRunCommands,
    handleUnknownSlashCommand,
  ];

  async function dispatchAuthorizedMessage(chatId, text) {
    for (const handler of authorizedMessageHandlers) {
      if (await handler(chatId, text)) return;
    }
  }

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();
    if (!text) return;

    // bootstrap: allow /id even before whitelist set
    if (await handleBootstrapCommands(chatId, text)) {
      return;
    }

    if (!isAllowed(chatId)) {
      try {
        await bot.sendMessage(chatId, "Unauthorized.");
      } catch {}
      return;
    }

    await dispatchAuthorizedMessage(chatId, text);
  });
}

module.exports = {
  createCommandRouter,
};
