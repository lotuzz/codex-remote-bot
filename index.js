// D:\Asistant\codex-remote-bot\index.js
// Telegram → Server Agent (Codex + Sys templates + Git ops + Codex model/quota helpers)

const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

/* -----------------------------
 * Helpers
 * ----------------------------- */
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

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function chunkText(text, maxLen = 3500) {
  const t = text || "";
  if (t.length <= maxLen) return [t];
  const chunks = [];
  for (let i = 0; i < t.length; i += maxLen) chunks.push(t.slice(i, i + maxLen));
  return chunks;
}

function sanitizeForTelegramCodeBlock(text) {
  return (text || "").replace(/```/g, "``\\`");
}

/* -----------------------------
 * Root paths (your structure)
 * ----------------------------- */
const ASSISTANT_ROOT = process.env.ASSISTANT_ROOT || "D:\\Asistant";
const OPS_DIR = process.env.OPS_DIR || path.join(ASSISTANT_ROOT, "ops");
const APPLICATIONS_DIR = process.env.APPLICATIONS_DIR || path.join(ASSISTANT_ROOT, "applications");

ensureDir(OPS_DIR);
ensureDir(APPLICATIONS_DIR);

const LOG_FILE = path.join(OPS_DIR, "telegram-agent.log");
function logLine(line) {
  try {
    fs.appendFileSync(LOG_FILE, `[${nowIso()}] ${line}\n`, "utf8");
  } catch {}
}

/* -----------------------------
 * Required env
 * ----------------------------- */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN belum diisi di .env");

const allowedChatIds = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const workspaceMap = parseKeyValueList(process.env.CODEX_WORKSPACES);
const repoMap = parseKeyValueList(process.env.GIT_REPOS);

const ALLOW_NETWORK_TASKS = toBool(process.env.ALLOW_NETWORK_TASKS, false);
const ALLOW_GIT_FREEFORM = toBool(process.env.ALLOW_GIT_FREEFORM, false);

// Codex config path (Windows default: %USERPROFILE%\.codex\config.toml)
const CODEX_CONFIG_PATH =
  process.env.CODEX_CONFIG_PATH ||
  path.join(process.env.USERPROFILE || "C:\\Users\\Default", ".codex", "config.toml");

/* -----------------------------
 * Telegram bot
 * ----------------------------- */
const bot = new TelegramBot(token, { polling: true });

bot.on("polling_error", (err) => {
  logLine(`polling_error: ${err?.message || String(err)}`);
});

let busy = false;
const pending = new Map(); // code -> { chatId, kind, payload, createdAt }

/* -----------------------------
 * Access control
 * ----------------------------- */
function isAllowed(chatId) {
  if (allowedChatIds.size === 0) return false;
  return allowedChatIds.has(String(chatId));
}

async function safeSend(chatId, text) {
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
}

/* -----------------------------
 * Workspace validation
 * ----------------------------- */
function resolveWorkspace(alias) {
  const raw = workspaceMap[alias];
  if (!raw) return null;

  const abs = path.resolve(raw);
  const appsRoot = path.resolve(APPLICATIONS_DIR);

  // recommended: under applications
  if (
    abs.toLowerCase().startsWith(appsRoot.toLowerCase() + path.sep.toLowerCase()) ||
    abs.toLowerCase() === appsRoot.toLowerCase()
  ) {
    return abs;
  }

  // allow but warn
  logLine(`WARN workspace '${alias}' is outside APPLICATIONS_DIR: ${abs}`);
  return abs;
}

/* -----------------------------
 * Process execution
 * ----------------------------- */
function runCmd(cmd, args, opts = {}) {
  logLine(`RUN: ${cmd} ${args.join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("error", (e) =>
      resolve({ ok: false, code: -1, out: out.trim(), err: (e?.message || String(e)).trim() })
    );
    child.on("close", (code) => resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() }));
  });
}

/* -----------------------------
 * Codex model config read/write
 * ----------------------------- */
function readCodexConfigToml() {
  try {
    return fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
  } catch {
    return null;
  }
}

function getModelFromToml(tomlText) {
  // tries to find top-level: model = "..."
  // (kept simple; assumes not inside a table)
  if (!tomlText) return null;
  const re = /^\s*model\s*=\s*"(.*?)"\s*$/m;
  const m = tomlText.match(re);
  return m ? m[1] : null;
}

function setModelInToml(existingToml, model) {
  const toml = existingToml || "";
  const re = /^\s*model\s*=\s*"(.*?)"\s*$/m;

  if (re.test(toml)) {
    return toml.replace(re, `model = "${model}"`);
  }

  // Insert model at the top, before first table ([...]) if possible
  const lines = toml.split(/\r?\n/);
  const tableIdx = lines.findIndex((l) => /^\s*\[.+\]\s*$/.test(l));

  const insertLine = `model = "${model}"`;
  if (tableIdx === -1) {
    // no tables; just prepend with a blank line
    return [insertLine, "", ...lines].join("\n").trimStart();
  }
  // insert before first table
  const before = lines.slice(0, tableIdx);
  const after = lines.slice(tableIdx);
  return [...before, insertLine, "", ...after].join("\n").trimStart();
}

function writeCodexModel(model) {
  ensureDir(path.dirname(CODEX_CONFIG_PATH));

  const current = readCodexConfigToml() || "";
  const updated = setModelInToml(current, model);

  // backup
  try {
    if (current) {
      const bak = CODEX_CONFIG_PATH + `.bak.${Date.now()}`;
      fs.writeFileSync(bak, current, "utf8");
      logLine(`BACKUP: ${bak}`);
    }
  } catch {}

  fs.writeFileSync(CODEX_CONFIG_PATH, updated, "utf8");
}

/* -----------------------------
 * Active model for bot-run execs
 * ----------------------------- */
let activeModel = null;
try {
  activeModel = getModelFromToml(readCodexConfigToml());
} catch {
  activeModel = null;
}

/* -----------------------------
 * Codex exec wrapper (non-interactive)
 * - Uses -a never so it never waits for terminal approvals.
 * - Adds --model if activeModel is set.
 * ----------------------------- */
async function codexExec({ workspacePath, sandboxMode, prompt, enableNetwork = false, modelOverride = null }) {
  const args = ["exec", "-a", "never", "--sandbox", sandboxMode, "-C", workspacePath];

  const modelToUse = modelOverride || activeModel;
  if (modelToUse) {
    args.push("--model", modelToUse);
  }

  // optional network override (workspace-write)
  if (enableNetwork) {
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }

  args.push(prompt);
  return runCmd("codex", args);
}

/* -----------------------------
 * Codex usage probe (JSONL)
 * - Shows token usage of ONE tiny probe run (not remaining limits).
 * - Parses turn.completed.usage from JSONL output. :contentReference[oaicite:4]{index=4}
 * ----------------------------- */
async function codexUsageProbe() {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "-a",
    "never",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
  ];

  if (activeModel) {
    args.push("--model", activeModel);
  }

  // minimal prompt
  args.push("Reply with exactly: OK");

  logLine(`RUN: codex ${args.join(" ")}`);

  return new Promise((resolve) => {
    const child = spawn("codex", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (e) =>
      resolve({ ok: false, code: -1, out: "", err: (e?.message || String(e)).trim() })
    );
    child.on("close", (code) => {
      // parse JSONL lines, find last turn.completed usage
      let usage = null;
      try {
        const lines = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        for (const line of lines) {
          const obj = JSON.parse(line);
          if (obj?.type === "turn.completed" && obj?.usage) usage = obj.usage;
        }
      } catch (e) {
        // ignore parse errors
      }

      const ok = code === 0;
      const out = usage
        ? `Probe usage (tokens):\n- input_tokens: ${usage.input_tokens}\n- cached_input_tokens: ${usage.cached_input_tokens}\n- output_tokens: ${usage.output_tokens}`
        : "Probe finished, tapi tidak berhasil membaca usage dari JSONL output.";

      resolve({
        ok,
        code,
        out,
        err: stderr.trim(),
      });
    });
  });
}

/* -----------------------------
 * SYS task templates (no free-form)
 * ----------------------------- */
function sysHelp() {
  return [
    "SYS tasks:",
    "/sys docker_install",
    "/sys docker_verify",
    "/sys ollama_install",
    "/sys reboot",
    "",
    "GIT ops:",
    "/sys repo_clone <alias>",
    "/sys repo_pull <alias>",
    "/sys repo_status <alias>",
    "",
    "Semua /sys butuh konfirmasi: /confirm <kode>",
  ].join("\n");
}

async function execSysTask(task, arg1) {
  switch (task) {
    case "docker_install":
      return runCmd("winget", ["install", "-e", "--id", "Docker.DockerDesktop"]);

    case "docker_verify": {
      const a = await runCmd("docker", ["--version"]);
      const b = await runCmd("docker", ["compose", "version"]);
      const ok = a.ok && b.ok;
      return {
        ok,
        code: ok ? 0 : 1,
        out: ["docker --version:", a.out || a.err || "(no output)", "", "docker compose version:", b.out || b.err || "(no output)"].join("\n"),
        err: "",
      };
    }

    case "ollama_install":
      return runCmd("winget", ["install", "-e", "--id", "Ollama.Ollama"]);

    case "reboot":
      return runCmd("shutdown", ["/r", "/t", "0"]);

    // ---- Git ops ----
    case "repo_clone": {
      const alias = (arg1 || "").trim();
      if (!alias) return { ok: false, code: 1, out: "", err: "Usage: /sys repo_clone <alias>" };

      const dest = resolveWorkspace(alias);
      if (!dest) return { ok: false, code: 1, out: "", err: `Workspace alias '${alias}' tidak ada.` };

      const url = repoMap[alias];
      if (!url && !ALLOW_GIT_FREEFORM) {
        return { ok: false, code: 1, out: "", err: `Repo URL untuk alias '${alias}' belum ada di GIT_REPOS (.env).` };
      }

      ensureDir(dest);
      const files = fs.readdirSync(dest);
      if (files.length > 0) {
        return { ok: false, code: 1, out: "", err: `Folder '${dest}' tidak kosong. Gunakan /sys repo_pull ${alias}.` };
      }

      return runCmd("git", ["clone", url, dest]);
    }

    case "repo_pull": {
      const alias = (arg1 || "").trim();
      if (!alias) return { ok: false, code: 1, out: "", err: "Usage: /sys repo_pull <alias>" };

      const dest = resolveWorkspace(alias);
      if (!dest) return { ok: false, code: 1, out: "", err: `Workspace alias '${alias}' tidak ada.` };

      return runCmd("git", ["-C", dest, "pull", "--ff-only"]);
    }

    case "repo_status": {
      const alias = (arg1 || "").trim();
      if (!alias) return { ok: false, code: 1, out: "", err: "Usage: /sys repo_status <alias>" };

      const dest = resolveWorkspace(alias);
      if (!dest) return { ok: false, code: 1, out: "", err: `Workspace alias '${alias}' tidak ada.` };

      return runCmd("git", ["-C", dest, "status", "-sb"]);
    }

    default:
      return { ok: false, code: 1, out: "", err: "Task sys tidak dikenal. Ketik /help" };
  }
}

/* -----------------------------
 * Approval flow
 * ----------------------------- */
function makeConfirmCode() {
  return crypto.randomBytes(3).toString("hex");
}

async function enqueueWithConfirm(chatId, kind, payload, summaryLines) {
  const code = makeConfirmCode();
  pending.set(code, { chatId, kind, payload, createdAt: Date.now() });

  const msg = [
    "⚠️ Konfirmasi diperlukan",
    ...summaryLines,
    `Kode: ${code}`,
    "",
    `Ketik /confirm ${code} untuk lanjut`,
    `atau /cancel ${code} untuk batal`,
  ].join("\n");

  await safeSend(chatId, msg);
}

/* -----------------------------
 * Help text
 * ----------------------------- */
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

function helpText() {
  const ws = Object.entries(workspaceMap).map(([k, v]) => `- ${k} => ${v}`).join("\n") || "(set CODEX_WORKSPACES di .env)";
  const repos = Object.entries(repoMap).map(([k, v]) => `- ${k} => ${v}`).join("\n") || "(optional: set GIT_REPOS di .env)";

  return [
    "🤖 Telegram → Server Agent",
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
    sysHelp(),
    "",
    codexHelpText(),
    "",
    "Workspaces:",
    ws,
    "",
    "Repos (for clone):",
    repos,
    "",
    `Active model: ${activeModel || "(default Codex recommended model)"}`,
    `Codex config: ${CODEX_CONFIG_PATH}`,
    `ALLOW_NETWORK_TASKS=${ALLOW_NETWORK_TASKS}`,
    `Log: ${LOG_FILE}`,
  ].join("\n");
}

/* -----------------------------
 * Main message handler
 * ----------------------------- */
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  // Bootstrap: allow /id even before whitelist set
  if (text === "/id") {
    await safeSend(chatId, `chat.id kamu: ${chatId}\nMasukkan ke TELEGRAM_ALLOWED_CHAT_IDS di .env lalu restart bot.`);
    return;
  }

  // Enforce whitelist
  if (!isAllowed(chatId)) {
    try { await bot.sendMessage(chatId, "⛔ Unauthorized."); } catch {}
    return;
  }

  // Basic
  if (text === "/start" || text === "/help") {
    await safeSend(chatId, helpText());
    return;
  }

  if (text === "/status") {
    await safeSend(chatId, `Status: ${busy ? "BUSY" : "IDLE"}`);
    return;
  }

  if (text === "/workspaces") {
    const ws = Object.entries(workspaceMap).map(([k, v]) => `- ${k} => ${v}`).join("\n") || "(set CODEX_WORKSPACES di .env)";
    await safeSend(chatId, "Workspaces:\n" + ws);
    return;
  }

  if (text === "/pending") {
    const list =
      [...pending.entries()]
        .slice(0, 30)
        .map(([code, p]) => `- ${code} (${p.kind}, age=${Math.round((Date.now() - p.createdAt) / 1000)}s)`)
        .join("\n") || "(kosong)";
    await safeSend(chatId, "Pending confirmations:\n" + list);
    return;
  }

  if (text.startsWith("/cancel ")) {
    const code = text.split(/\s+/, 2)[1];
    if (pending.has(code)) {
      pending.delete(code);
      await safeSend(chatId, `❎ Task ${code} dibatalkan.`);
    } else {
      await safeSend(chatId, "Kode tidak ditemukan.");
    }
    return;
  }

  if (text.startsWith("/confirm ")) {
    const code = text.split(/\s+/, 2)[1];
    const item = pending.get(code);
    if (!item) {
      await safeSend(chatId, "Kode konfirmasi tidak ada/expired.");
      return;
    }
    if (String(item.chatId) !== String(chatId)) {
      await safeSend(chatId, "Kode ini bukan untuk chat ini.");
      return;
    }

    if (busy) {
      await safeSend(chatId, "⏳ Masih ada task lain berjalan.");
      return;
    }

    pending.delete(code);
    busy = true;
    try {
      await safeSend(chatId, `🚀 Menjalankan task (${item.kind})...`);

      let res;
      if (item.kind === "sys") {
        const { task, arg1 } = item.payload;
        res = await execSysTask(task, arg1);
      } else if (item.kind === "codex") {
        res = await codexExec(item.payload);
      } else if (item.kind === "codex_admin") {
        // codex admin ops that may write config
        const { action, value } = item.payload;
        if (action === "set_model") {
          writeCodexModel(value);
          activeModel = value;
          res = { ok: true, code: 0, out: `Model default diset ke: ${value}\nConfig: ${CODEX_CONFIG_PATH}`, err: "" };
        } else {
          res = { ok: false, code: 1, out: "", err: "Unknown codex_admin action" };
        }
      } else if (item.kind === "codex_usage_probe") {
        res = await codexUsageProbe();
      } else {
        res = { ok: false, code: 1, out: "", err: "Unknown task kind." };
      }

      const header = res.ok ? `✅ Selesai (exit ${res.code})` : `⚠️ Error (exit ${res.code})`;
      const payload = [header, "", "OUTPUT:", res.out || "(kosong)", "", "ERROR/LOG:", res.err || "(kosong)"].join("\n");
      logLine(`RESULT kind=${item.kind} ok=${res.ok} code=${res.code}`);
      await safeSend(chatId, payload);
    } finally {
      busy = false;
    }
    return;
  }

  // -------- Codex management commands --------
  if (text === "/codex" || text === "/codex help") {
    await safeSend(chatId, codexHelpText());
    return;
  }

  if (text === "/codex version") {
    const res = await runCmd("codex", ["--version"]);
    await safeSend(chatId, res.ok ? res.out : (res.out + "\n" + res.err));
    return;
  }

  if (text === "/codex auth") {
    // codex login status prints auth mode, useful for automation. :contentReference[oaicite:5]{index=5}
    const res = await runCmd("codex", ["login", "status"]);
    const out = res.ok ? res.out : (res.out + "\n" + res.err);
    await safeSend(chatId, out || "(no output)");
    return;
  }

  if (text === "/codex model") {
    const cfg = readCodexConfigToml();
    const cfgModel = getModelFromToml(cfg);
    const msgOut = [
      `Active model (bot): ${activeModel || "(Codex default recommended model)"}`,
      `Config model: ${cfgModel || "(not set)"}`,
      `Config path: ${CODEX_CONFIG_PATH}`,
      "",
      "Note: Codex CLI juga bisa override per-run dengan --model/-m. :contentReference[oaicite:6]{index=6}",
    ].join("\n");
    await safeSend(chatId, msgOut);
    return;
  }

  if (text.startsWith("/codex set_model ")) {
    const model = text.replace("/codex set_model", "").trim();
    if (!model) {
      await safeSend(chatId, "Usage: /codex set_model <model>\nContoh: /codex set_model gpt-5.3-codex");
      return;
    }

    await enqueueWithConfirm(chatId, "codex_admin", { action: "set_model", value: model }, [
      "Kind: CODEX_ADMIN",
      `Action: set_model`,
      `Model: ${model}`,
    ]);
    return;
  }

  if (text === "/codex models") {
    // Quick list based on docs models page. :contentReference[oaicite:7]{index=7}
    const out = [
      "Recommended Codex models (examples):",
      "- gpt-5.3-codex",
      "- gpt-5.2-codex",
      "- gpt-5.2",
      "- gpt-5.1-codex-max",
      "- gpt-5.1",
      "",
      'Kamu bisa set default via `/codex set_model <model>` atau override per run dengan `--model/-m`. :contentReference[oaicite:8]{index=8}',
    ].join("\n");
    await safeSend(chatId, out);
    return;
  }

  if (text === "/codex quota") {
    const out = [
      "Remaining limits / 'kuota' Codex:",
      "- Cara resmi: cek di Codex usage dashboard, atau buka Codex CLI interaktif lalu jalankan `/status`. :contentReference[oaicite:9]{index=9}",
      "",
      "Catatan:",
      "- Bot ini pakai `codex exec` (non-interactive), dan tidak ada perintah resmi untuk mengambil 'remaining limits' langsung dari mode ini.",
      "- Kalau kamu butuh angka token pemakaian per run, pakai: /codex usage_probe",
    ].join("\n");
    await safeSend(chatId, out);
    return;
  }

  if (text === "/codex usage_probe") {
    await enqueueWithConfirm(chatId, "codex_usage_probe", {}, [
      "Kind: CODEX_USAGE_PROBE",
      "Action: run 1 tiny codex exec --json to read turn.completed.usage (tokens).",
      `Model: ${activeModel || "(default)"}`,
      "Note: ini mengonsumsi sedikit kuota karena benar-benar menjalankan 1 request.",
    ]);
    return;
  }

  // -------- /sys ... --------
  if (text.startsWith("/sys")) {
    const parts = text.split(/\s+/);
    const task = parts[1];
    const arg1 = parts[2];

    if (!task) {
      await safeSend(chatId, sysHelp());
      return;
    }

    await enqueueWithConfirm(chatId, "sys", { task, arg1 }, [
      "Kind: SYS",
      `Task: ${task}${arg1 ? " " + arg1 : ""}`,
    ]);
    return;
  }

  // -------- Codex runs: /ask /run /runnet --------
  function parsePipeCommand(body) {
    // <alias> | <prompt>
    const idx = body.indexOf("|");
    if (idx === -1) return null;
    const alias = body.slice(0, idx).trim();
    const prompt = body.slice(idx + 1).trim();
    if (!alias || !prompt) return null;
    return { alias, prompt };
  }

  if (text.startsWith("/ask ")) {
    const parsed = parsePipeCommand(text.slice(5).trim());
    if (!parsed) {
      await safeSend(chatId, "Format: /ask <alias> | <prompt>");
      return;
    }

    const wsPath = resolveWorkspace(parsed.alias);
    if (!wsPath) {
      await safeSend(chatId, `Workspace alias '${parsed.alias}' tidak ada. Cek /workspaces`);
      return;
    }

    await enqueueWithConfirm(chatId, "codex", {
      workspacePath: wsPath,
      sandboxMode: "read-only",
      prompt: parsed.prompt,
      enableNetwork: false,
    }, [
      "Kind: CODEX",
      "Mode: ask (read-only)",
      `Workspace: ${parsed.alias}`,
      `Model: ${activeModel || "(default)"}`,
    ]);
    return;
  }

  if (text.startsWith("/run ")) {
    const parsed = parsePipeCommand(text.slice(5).trim());
    if (!parsed) {
      await safeSend(chatId, "Format: /run <alias> | <prompt>");
      return;
    }

    const wsPath = resolveWorkspace(parsed.alias);
    if (!wsPath) {
      await safeSend(chatId, `Workspace alias '${parsed.alias}' tidak ada. Cek /workspaces`);
      return;
    }

    await enqueueWithConfirm(chatId, "codex", {
      workspacePath: wsPath,
      sandboxMode: "workspace-write",
      prompt: parsed.prompt,
      enableNetwork: false,
    }, [
      "Kind: CODEX",
      "Mode: run (workspace-write)",
      `Workspace: ${parsed.alias}`,
      `Model: ${activeModel || "(default)"}`,
    ]);
    return;
  }

  if (text.startsWith("/runnet ")) {
    if (!ALLOW_NETWORK_TASKS) {
      await safeSend(chatId, "runnet dimatikan (ALLOW_NETWORK_TASKS=false). Aktifkan di .env jika ingin.");
      return;
    }

    const parsed = parsePipeCommand(text.slice(8).trim());
    if (!parsed) {
      await safeSend(chatId, "Format: /runnet <alias> | <prompt>");
      return;
    }

    const wsPath = resolveWorkspace(parsed.alias);
    if (!wsPath) {
      await safeSend(chatId, `Workspace alias '${parsed.alias}' tidak ada. Cek /workspaces`);
      return;
    }

    await enqueueWithConfirm(chatId, "codex", {
      workspacePath: wsPath,
      sandboxMode: "workspace-write",
      prompt: parsed.prompt,
      enableNetwork: true,
    }, [
      "Kind: CODEX",
      "Mode: runnet (workspace-write + network)",
      `Workspace: ${parsed.alias}`,
      `Model: ${activeModel || "(default)"}`,
    ]);
    return;
  }

  // Unknown command
  if (text.startsWith("/")) {
    await safeSend(chatId, "Perintah tidak dikenal. Ketik /help");
  }
});

/* -----------------------------
 * Startup log
 * ----------------------------- */
console.log("Telegram agent running (polling)...");
logLine("Bot started.");

/*
.env example (add to D:\Asistant\codex-remote-bot\.env)

TELEGRAM_BOT_TOKEN=123456789:AA....
TELEGRAM_ALLOWED_CHAT_IDS=123456789

ASSISTANT_ROOT=D:\Asistant
OPS_DIR=D:\Asistant\ops
APPLICATIONS_DIR=D:\Asistant\applications

CODEX_WORKSPACES=morajobs=D:\Asistant\applications\morajobs;morapos=D:\Asistant\applications\morapos;serbaberes=D:\Asistant\applications\serbaberes
GIT_REPOS=morajobs=git@github.com:USER/morajobs.git;morapos=git@github.com:USER/morapos.git;serbaberes=git@github.com:USER/serbaberes.git

ALLOW_NETWORK_TASKS=false
CODEX_CONFIG_PATH=C:\Users\<user>\.codex\config.toml
*/