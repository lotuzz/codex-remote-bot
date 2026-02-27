const fs = require("fs");
const path = require("path");

function createCodexService({ codexConfigPath, runCmd, ensureDir, logLine = () => {} }) {
  function readCodexConfigToml() {
    try {
      return fs.readFileSync(codexConfigPath, "utf8");
    } catch {
      return null;
    }
  }

  function getModelFromToml(tomlText) {
    // tries to find top-level: model = "..."
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

    // insert model before first table if exists
    const lines = toml.split(/\r?\n/);
    const tableIdx = lines.findIndex((l) => /^\s*\[.+\]\s*$/.test(l));
    const insertLine = `model = "${model}"`;

    if (tableIdx === -1) {
      return [insertLine, "", ...lines].join("\n").trimStart();
    }

    const before = lines.slice(0, tableIdx);
    const after = lines.slice(tableIdx);
    return [...before, insertLine, "", ...after].join("\n").trimStart();
  }

  function writeCodexModel(model) {
    ensureDir(path.dirname(codexConfigPath));

    const current = readCodexConfigToml() || "";
    const updated = setModelInToml(current, model);

    // backup
    try {
      if (current) {
        const bak = codexConfigPath + `.bak.${Date.now()}`;
        fs.writeFileSync(bak, current, "utf8");
        logLine(`BACKUP: ${bak}`);
      }
    } catch {}

    fs.writeFileSync(codexConfigPath, updated, "utf8");
  }

  let activeModel = null;
  try {
    activeModel = getModelFromToml(readCodexConfigToml());
  } catch {
    activeModel = null;
  }

  async function execTask({ workspacePath, sandboxMode, prompt, enableNetwork = false, modelOverride = null }) {
    const args = ["exec", "-a", "never", "--sandbox", sandboxMode, "-C", workspacePath];
    const modelToUse = modelOverride || activeModel;

    if (modelToUse) {
      args.push("--model", modelToUse);
    }

    if (enableNetwork) {
      args.push("-c", "sandbox_workspace_write.network_access=true");
    }

    args.push(prompt);
    return runCmd("codex", args);
  }

  async function usageProbe() {
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

    args.push("Reply with exactly: OK");

    const res = await runCmd("codex", args);
    if (!res.ok) return res;

    let usage = null;
    try {
      const lines = res.out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj?.type === "turn.completed" && obj?.usage) {
          usage = obj.usage;
        }
      }
    } catch {}

    return {
      ok: true,
      code: res.code,
      out: usage
        ? `Probe usage (tokens):\n- input_tokens: ${usage.input_tokens}\n- cached_input_tokens: ${usage.cached_input_tokens}\n- output_tokens: ${usage.output_tokens}`
        : "Probe finished, tapi tidak berhasil membaca usage dari JSONL output.",
      err: res.err,
    };
  }

  function getActiveModel() {
    return activeModel;
  }

  function getConfigPath() {
    return codexConfigPath;
  }

  function getConfigModel() {
    return getModelFromToml(readCodexConfigToml());
  }

  function setDefaultModel(model) {
    writeCodexModel(model);
    activeModel = model;
    return {
      ok: true,
      code: 0,
      out: `Model default diset ke: ${model}\nConfig: ${codexConfigPath}`,
      err: "",
    };
  }

  return {
    execTask,
    usageProbe,
    getActiveModel,
    getConfigPath,
    getConfigModel,
    setDefaultModel,
  };
}

module.exports = {
  createCodexService,
};
