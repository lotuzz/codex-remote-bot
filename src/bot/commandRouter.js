const crypto = require("crypto");
const { parsePipeCommand, parseSecondToken, parseDockerPipeCommand } = require("../utils/parsers");

function createCommandRouter({
  bot,
  safeSend,
  config,
  logLine,
  runCmd,
  workspaceService,
  codexService,
  sysService,
  dockerService,
  ollamaService,
}) {
  let busy = false;
  const pending = new Map(); // code -> { chatId, kind, payload, createdAt }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

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
    ].join("\n");
  }

  function ollamaHelpText() {
    return [
      "Ollama commands:",
      "/ollama",
      "/ollama list",
      "/ollama ps",
      "/ollama pull <model>",
      "/ollama stop <model>",
    ].join("\n");
  }

  function helpText() {
    const stripLeadingDash = (line) => String(line || "").replace(/^\s*-\s*/, "").trim();

    const workspaceLines = workspaceService
      .formatWorkspaceList()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `- <code>${escapeHtml(stripLeadingDash(line))}</code>`)
      .join("\n");

    return [
      "<b>Telegram -&gt; Server Agent</b>",
      "",
      "<b>Umum</b>",
      "- <code>/help</code>",
      "- <code>/id</code>",
      "- <code>/status</code>",
      "- <code>/workspaces</code>",
      "- <code>/pending</code>",
      "",
      "<b>Codex (Coding)</b>",
      "- <code>/ask &lt;workspace&gt; | &lt;prompt&gt;</code> (sandbox: read-only)",
      "- <code>/run &lt;workspace&gt; | &lt;prompt&gt;</code> (sandbox: workspace-write)",
      "- <code>/runnet &lt;workspace&gt; | &lt;prompt&gt;</code> (workspace-write + network, jika diizinkan)",
      "",
      "<b>Sys / Ops</b>",
      "- <code>/sys reboot</code>",
      "- <code>/sys memory</code>",
      "<b><i>Konfirmasi: <code>/confirm &lt;kode&gt;</code> atau <code>/cancel &lt;kode&gt;</code></i></b>",
      "",
      "<b>Git Ops</b>",
      "- <code>/git pull &lt;workspace&gt;</code>",
      "- <code>/git status &lt;workspace&gt;</code>",
      "<b><i>Konfirmasi: <code>/confirm &lt;kode&gt;</code> atau <code>/cancel &lt;kode&gt;</code></i></b>",
      "",
      "<b>Docker Ops</b>",
      "- <code>/docker | &lt;prompt&gt;</code>",
      "- <code>/docker &lt;container&gt; | &lt;prompt&gt;</code>",
      "<b><i>Contoh: <code>/docker web | cek logs error lalu restart</code></i></b>",
      "",
      "<b>Ollama Ops</b>",
      "- <code>/ollama</code>",
      "- <code>/ollama list</code>",
      "- <code>/ollama ps</code>",
      "- <code>/ollama pull &lt;model&gt;</code>",
      "- <code>/ollama stop &lt;model&gt;</code>",
      "<b><i>Konfirmasi hanya untuk <code>pull</code> dan <code>stop</code>: <code>/confirm &lt;kode&gt;</code> atau <code>/cancel &lt;kode&gt;</code></i></b>",
      "",
      "<b>Codex Management</b>",
      "- <code>/codex</code>",
      "- <code>/codex version</code>",
      "- <code>/codex auth</code>",
      "- <code>/codex model</code>",
      "- <code>/codex set_model &lt;model&gt;</code>",
      "- <code>/codex models</code>",
      "",
      "<b>Workspaces</b>",
      workspaceLines || "<i>(kosong)</i>",
      "",
      "<b>Info</b>",
      `- Active model: <code>${escapeHtml(codexService.getActiveModel() || "(default Codex recommended model)")}</code>`,
      `- Codex config: <code>${escapeHtml(codexService.getConfigPath())}</code>`,
      `- ALLOW_NETWORK_TASKS=<code>${escapeHtml(String(config.allowNetworkTasks))}</code>`,
      `- Log: <code>${escapeHtml(config.logFile)}</code>`,
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

    if (item.kind === "docker") {
      return dockerService.execDockerPlan(item.payload.plan);
    }

    if (item.kind === "ollama") {
      return ollamaService.execTask(item.payload);
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
      await safeSend(chatId, helpText(), { mode: "html" });
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

    return false;
  }

  async function handleDockerCommands(chatId, text) {
    if (text === "/docker" || text === "/docker help") {
      const usage = [
        "Format:",
        "/docker | <prompt>",
        "/docker <container> | <prompt>",
        "",
        "Contoh:",
        "/docker | cek container yang error",
        "/docker web | cek logs 100 lines",
        "/docker web | cek error lalu restart",
      ].join("\n");
      await safeSend(chatId, usage);
      return true;
    }

    if (!/^\/docker(\s|\|)/.test(text)) return false;

    const parsed = parseDockerPipeCommand(text.slice("/docker".length).trim());
    if (!parsed) {
      await safeSend(chatId, "Format: /docker | <prompt>\natau: /docker <container> | <prompt>");
      return true;
    }

    const planned = await dockerService.planDockerTask({
      containerSelector: parsed.selector,
      prompt: parsed.prompt,
    });

    if (!planned.ok || !planned.plan) {
      await safeSend(chatId, `Docker plan gagal:\n${planned.err || planned.out || "(unknown error)"}`);
      return true;
    }

    const preview = dockerService.formatPlanPreview(planned.plan);
    await enqueueWithConfirm(chatId, "docker", { plan: planned.plan }, [
      "Kind: DOCKER",
      ...preview.split(/\r?\n/),
    ]);

    return true;
  }

  async function handleOllamaCommands(chatId, text) {
    if (text === "/ollama" || text === "/ollama help") {
      await safeSend(chatId, ollamaHelpText());
      return true;
    }

    if (text === "/ollama list") {
      const res = await ollamaService.listModels();
      await safeSend(chatId, res.ok ? res.out : res.out + "\n" + res.err);
      return true;
    }

    if (text === "/ollama ps") {
      const res = await ollamaService.listRunningModels();
      await safeSend(chatId, res.ok ? res.out : res.out + "\n" + res.err);
      return true;
    }

    if (!text.startsWith("/ollama ")) return false;

    const parts = text.split(/\s+/);
    const action = (parts[1] || "").trim().toLowerCase();
    const model = text.replace(/^\/ollama\s+\S+/, "").trim();

    if (!action || !model) {
      await safeSend(chatId, "Format: /ollama pull <model>\natau: /ollama stop <model>");
      return true;
    }

    if (action !== "pull" && action !== "stop") {
      await safeSend(chatId, "Subcommand /ollama tidak dikenal. Pakai: list | ps | pull | stop");
      return true;
    }

    await enqueueWithConfirm(chatId, "ollama", { action, model }, [
      "Kind: OLLAMA",
      `Action: ${action}`,
      `Model: ${model}`,
      `Host: ${ollamaService.getBaseUrl()}`,
    ]);
    return true;
  }

  async function handleGitCommands(chatId, text) {
    if (text === "/git" || text === "/git help") {
      const usage = [
        "Format:",
        "/git pull <workspace>",
        "/git status <workspace>",
      ].join("\n");
      await safeSend(chatId, usage);
      return true;
    }

    if (!text.startsWith("/git ")) return false;

    const parts = text.split(/\s+/);
    const sub = (parts[1] || "").trim().toLowerCase();
    const workspace = (parts[2] || "").trim();

    if (!sub || !workspace) {
      await safeSend(chatId, "Format: /git pull <workspace>\natau: /git status <workspace>");
      return true;
    }

    const task = sub === "pull" ? "repo_pull" : sub === "status" ? "repo_status" : null;
    if (!task) {
      await safeSend(chatId, "Subcommand /git tidak dikenal. Pakai: pull | status");
      return true;
    }

    await enqueueWithConfirm(chatId, "sys", { task, arg1: workspace }, [
      "Kind: GIT",
      `Task: ${sub} ${workspace}`,
    ]);
    return true;
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

    if (task === "repo_pull" || task === "repo_status") {
      await safeSend(chatId, "Perintah ini sudah dipindah ke /git.\nContoh: /git pull <workspace> atau /git status <workspace>");
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
    handleDockerCommands,
    handleOllamaCommands,
    handleGitCommands,
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
