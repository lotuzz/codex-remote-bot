function toLower(s) {
  return String(s || "").toLowerCase();
}

function containsAny(text, needles) {
  const t = toLower(text);
  return needles.some((w) => t.includes(toLower(w)));
}

function toInt(v, def = 0) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
}

function formatCommand(cmd, args) {
  return [cmd, ...(args || [])].join(" ");
}

function parseDockerPsOutput(out) {
  return String(out || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", name = "", status = ""] = line.split("\t");
      return {
        id: id.trim(),
        name: name.trim(),
        status: status.trim(),
        idLower: toLower(id.trim()),
        nameLower: toLower(name.trim()),
        statusLower: toLower(status.trim()),
      };
    })
    .filter((c) => c.name);
}

function isErrorContainerStatus(statusLower) {
  const s = toLower(statusLower);
  return s.includes("unhealthy") || s.includes("restarting") || s.startsWith("exited") || s.includes(" dead");
}

function rankAndPick(matches) {
  if (!matches || matches.length === 0) return null;
  return [...matches].sort((a, b) => {
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name);
  })[0];
}

function extractJsonObject(text) {
  const t = String(text || "");
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const raw = t.slice(first, last + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseCodexFinalMessage(jsonlText) {
  let finalMessage = null;
  const lines = String(jsonlText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "item.completed" && obj?.item?.type === "agent_message" && typeof obj.item.text === "string") {
        finalMessage = obj.item.text;
      }
    } catch {}
  }

  return finalMessage;
}

function createDockerService({ runCmd, logLine = () => {} }) {
  async function getContainers() {
    const res = await runCmd("docker", ["ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"]);
    if (!res.ok) return { ok: false, err: res.err || res.out || "Gagal membaca docker ps -a" };
    return { ok: true, containers: parseDockerPsOutput(res.out) };
  }

  async function ensureDockerReady() {
    const res = await runCmd("docker", ["info", "--format", "{{.ServerVersion}}"]);
    if (!res.ok) {
      return {
        ok: false,
        err: res.err || res.out || "Docker daemon tidak berjalan atau tidak bisa diakses.",
      };
    }
    return { ok: true };
  }

  function resolveContainerSelector(containers, selector) {
    if (!selector) return { selected: null, alternatives: [] };
    const sel = toLower(selector.trim());
    if (!sel) return { selected: null, alternatives: [] };

    const tiers = [
      containers.filter((c) => c.nameLower === sel),
      containers.filter((c) => c.idLower.startsWith(sel) || c.nameLower.startsWith(sel)),
      containers.filter((c) => c.nameLower.includes(sel) || c.idLower.includes(sel)),
    ];

    const matches = tiers.find((arr) => arr.length > 0) || [];
    if (matches.length === 0) {
      return {
        selected: null,
        alternatives: [],
        err: `Container '${selector}' tidak ditemukan di docker ps -a.`,
      };
    }

    const selected = rankAndPick(matches);
    const alternatives = matches
      .filter((m) => m.name !== selected.name)
      .map((m) => m.name);

    return { selected, alternatives };
  }

  function inferContainerFromPrompt(containers, prompt) {
    const p = toLower(prompt);
    const found = containers.filter((c) => p.includes(c.nameLower));
    if (found.length === 0) return { selected: null, alternatives: [] };
    const selected = rankAndPick(found);
    return {
      selected,
      alternatives: found.filter((f) => f.name !== selected.name).map((f) => f.name),
    };
  }

  function parseLogTail(prompt) {
    const p = String(prompt || "");
    const patterns = [
      /(?:tail|last|baris|lines?)\s*[:=]?\s*(\d{1,4})/i,
      /(\d{1,4})\s*(?:baris|lines?)/i,
    ];
    for (const re of patterns) {
      const m = p.match(re);
      if (m?.[1]) {
        const n = Math.max(1, Math.min(500, toInt(m[1], 100)));
        return n;
      }
    }
    return 100;
  }

  function detectIntent(prompt) {
    const p = toLower(prompt);
    const hasError = containsAny(p, ["error", "err", "unhealthy", "bermasalah", "crash", "failed", "fail", "dead", "exited"]);
    const hasRestart = containsAny(p, ["restart"]);
    const hasStart = containsAny(p, ["start", "jalankan", "nyalakan"]);
    const hasStop = containsAny(p, ["stop", "hentikan", "matikan"]);
    const hasLogs = containsAny(p, ["logs", "log"]);
    const hasInspect = containsAny(p, ["inspect", "detail", "info"]);
    const hasStats = containsAny(p, ["stats", "resource", "cpu", "memory", "ram"]);
    const hasList = containsAny(p, ["cek", "check", "status", "list", "running", "container", "docker", "tampilkan"]);

    if (hasRestart && hasError) return "restart_if_error";
    if (hasLogs) return "logs";
    if (hasInspect) return "inspect";
    if (hasStats) return "stats";
    if (hasRestart) return "restart";
    if (hasStart) return "start";
    if (hasStop) return "stop";
    if (hasList) {
      if (containsAny(p, ["running", "aktif", "up"])) return "ps_running";
      return "ps_all";
    }
    return null;
  }

  function buildSimpleCommandPlan({
    intent,
    prompt,
    selectorRaw,
    target,
    alternatives = [],
    tail = 100,
    engine = "rule",
    fallbackReason = null,
  }) {
    let commandArgs = null;
    let readOnly = true;

    switch (intent) {
      case "ps_running":
        commandArgs = ["ps"];
        break;
      case "ps_all":
        commandArgs = ["ps", "-a"];
        break;
      case "logs":
        commandArgs = ["logs", "--tail", String(tail), target.name];
        break;
      case "inspect":
        commandArgs = ["inspect", target.name];
        break;
      case "stats":
        commandArgs = ["stats", "--no-stream", target.name];
        break;
      case "restart":
        commandArgs = ["restart", target.name];
        readOnly = false;
        break;
      case "start":
        commandArgs = ["start", target.name];
        readOnly = false;
        break;
      case "stop":
        commandArgs = ["stop", target.name];
        readOnly = false;
        break;
      default:
        return { ok: false, err: `Intent '${intent}' tidak didukung.` };
    }

    const command = {
      cmd: "docker",
      args: commandArgs,
      label: intent,
      readOnly,
    };

    const notes = [];
    if (alternatives.length > 0) {
      notes.push(`Auto-pick target '${target?.name || "-"}'. Kandidat lain: ${alternatives.join(", ")}`);
    }
    if (fallbackReason) {
      notes.push(`Codex fallback reason: ${fallbackReason}`);
    }

    const plan = {
      engine,
      intent,
      prompt,
      selectorRaw: selectorRaw || null,
      targetContainer: target?.name || null,
      readOnly,
      preview: {
        commands: [formatCommand(command.cmd, command.args)],
        notes,
      },
      execution: {
        mode: "commands",
        commands: [command],
      },
    };

    return { ok: true, plan };
  }

  function validateDockerCommand(cmd, args) {
    if (cmd !== "docker") return false;
    const a = args || [];
    const sub = a[0];
    if (!sub) return false;

    if (sub === "ps") {
      return a.length === 1 || (a.length === 2 && a[1] === "-a");
    }
    if (sub === "logs") {
      return a.length === 4 && a[1] === "--tail" && /^[0-9]+$/.test(String(a[2])) && Boolean(a[3]);
    }
    if (sub === "inspect") {
      return a.length === 2 && Boolean(a[1]);
    }
    if (sub === "stats") {
      return a.length === 3 && a[1] === "--no-stream" && Boolean(a[2]);
    }
    if (sub === "start" || sub === "stop" || sub === "restart") {
      return a.length === 2 && Boolean(a[1]);
    }

    return false;
  }

  function validateExecutionPlan(plan) {
    if (plan?.execution?.mode === "restart_if_error") return true;
    if (plan?.execution?.mode !== "commands") return false;
    return (plan.execution.commands || []).every((c) => validateDockerCommand(c.cmd, c.args));
  }

  function chooseTargetForIntent({ intent, selectorResolution, inferred, containers, selectorRaw }) {
    const targetRequired = ["logs", "inspect", "stats", "start", "stop", "restart"].includes(intent);
    if (!targetRequired) {
      return {
        ok: true,
        target: selectorResolution.selected || null,
        alternatives: selectorResolution.alternatives || [],
      };
    }

    if (selectorResolution.err) {
      return { ok: false, err: selectorResolution.err };
    }
    if (selectorResolution.selected) {
      return {
        ok: true,
        target: selectorResolution.selected,
        alternatives: selectorResolution.alternatives || [],
      };
    }
    if (inferred.selected) {
      return {
        ok: true,
        target: inferred.selected,
        alternatives: inferred.alternatives || [],
      };
    }
    if (containers.length === 1) {
      return { ok: true, target: containers[0], alternatives: [] };
    }

    if (selectorRaw) {
      return { ok: false, err: `Container '${selectorRaw}' tidak ditemukan.` };
    }

    return {
      ok: false,
      err: "Container target belum jelas. Gunakan format: /docker <container> | <prompt>",
    };
  }

  function buildRestartIfErrorPlan({ prompt, selectorRaw, selectorResolution, containers, inferred, engine = "rule", fallbackReason = null }) {
    if (selectorResolution.err) return { ok: false, err: selectorResolution.err };

    const scoped = selectorResolution.selected || inferred.selected || null;
    const scopedName = scoped ? scoped.name : null;
    const currentErrorTargets = containers
      .filter((c) => isErrorContainerStatus(c.statusLower))
      .filter((c) => !scopedName || c.name === scopedName);

    const commandsPreview = ["docker ps -a --format {{.ID}}\\t{{.Names}}\\t{{.Status}}"];
    if (currentErrorTargets.length > 0) {
      for (const c of currentErrorTargets) {
        commandsPreview.push(`docker restart ${c.name}`);
      }
    } else {
      commandsPreview.push(scopedName ? `docker restart ${scopedName} (jika status error)` : "docker restart <error-containers>");
    }

    const notes = [];
    if (selectorResolution.alternatives?.length) {
      notes.push(`Auto-pick target '${scopedName}'. Kandidat lain: ${selectorResolution.alternatives.join(", ")}`);
    }
    if (fallbackReason) {
      notes.push(`Codex fallback reason: ${fallbackReason}`);
    }
    if (currentErrorTargets.length === 0) {
      notes.push("Snapshot saat ini: belum ada container error yang terdeteksi.");
    } else {
      notes.push(`Snapshot error targets: ${currentErrorTargets.map((c) => c.name).join(", ")}`);
    }

    const plan = {
      engine,
      intent: "restart_if_error",
      prompt,
      selectorRaw: selectorRaw || null,
      targetContainer: scopedName,
      readOnly: false,
      preview: {
        commands: commandsPreview,
        notes,
      },
      execution: {
        mode: "restart_if_error",
        selectorName: scopedName,
      },
    };

    return { ok: true, plan };
  }

  function buildPlanFromIntent({
    intent,
    prompt,
    selectorRaw,
    selectorResolution,
    inferred,
    containers,
    engine = "rule",
    fallbackReason = null,
    fallbackTail = null,
  }) {
    if (intent === "restart_if_error") {
      return buildRestartIfErrorPlan({
        prompt,
        selectorRaw,
        selectorResolution,
        containers,
        inferred,
        engine,
        fallbackReason,
      });
    }

    const targetChoice = chooseTargetForIntent({
      intent,
      selectorResolution,
      inferred,
      containers,
      selectorRaw,
    });
    if (!targetChoice.ok) return targetChoice;

    const tail = intent === "logs" ? (fallbackTail != null ? Math.max(1, Math.min(500, toInt(fallbackTail, 100))) : parseLogTail(prompt)) : 100;
    return buildSimpleCommandPlan({
      intent,
      prompt,
      selectorRaw,
      target: targetChoice.target,
      alternatives: targetChoice.alternatives,
      tail,
      engine,
      fallbackReason,
    });
  }

  async function buildPlanWithCodexFallback({ prompt, selectorRaw, containers, selectorResolution, inferred }) {
    const containerNames = containers.slice(0, 50).map((c) => c.name).join(", ") || "(none)";
    const instruction = [
      "You are a Docker intent mapper.",
      "Return JSON only with keys: op, target, tail, reason.",
      "Allowed op values:",
      "- ps_running",
      "- ps_all",
      "- logs",
      "- inspect",
      "- stats",
      "- start",
      "- stop",
      "- restart",
      "- restart_if_error",
      "",
      `User prompt: ${prompt}`,
      `Explicit selector: ${selectorRaw || "(none)"}`,
      `Known containers: ${containerNames}`,
      "Rules:",
      "- Use only one op value from allowed list.",
      "- target should be a container name when op needs target, else null.",
      "- tail should be integer 1..500 for logs, else null.",
      "- reason should be short.",
      "",
      "Return JSON only. No markdown.",
    ].join("\n");

    const res = await runCmd("codex", [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      instruction,
    ]);

    if (!res.ok) {
      return {
        ok: false,
        err: "Codex fallback gagal dijalankan.",
      };
    }

    const finalMsg = parseCodexFinalMessage(res.out);
    const obj = extractJsonObject(finalMsg);
    if (!obj?.op) {
      return { ok: false, err: "Codex fallback tidak mengembalikan JSON op yang valid." };
    }

    const intent = String(obj.op || "").trim();
    const targetFromFallback = obj.target ? String(obj.target).trim() : null;
    const reason = obj.reason ? String(obj.reason).trim() : null;
    const tail = obj.tail != null ? toInt(obj.tail, 100) : null;

    const fallbackSelector = targetFromFallback || selectorRaw || null;
    const fallbackResolution = resolveContainerSelector(containers, fallbackSelector);
    const fallbackInferred = fallbackSelector ? { selected: null, alternatives: [] } : inferred;

    const planned = buildPlanFromIntent({
      intent,
      prompt,
      selectorRaw: fallbackSelector,
      selectorResolution: fallbackResolution,
      inferred: fallbackInferred,
      containers,
      engine: "codex_fallback",
      fallbackReason: reason,
      fallbackTail: tail,
    });

    return planned.ok ? planned : { ok: false, err: planned.err || "Codex fallback tidak bisa dipetakan ke safe ops." };
  }

  async function planDockerTask({ containerSelector = null, prompt }) {
    const ready = await ensureDockerReady();
    if (!ready.ok) {
      return { ok: false, code: 1, out: "", err: ready.err };
    }

    const list = await getContainers();
    if (!list.ok) {
      return { ok: false, code: 1, out: "", err: list.err };
    }

    const containers = list.containers;
    const selectorResolution = resolveContainerSelector(containers, containerSelector);
    const inferred = inferContainerFromPrompt(containers, prompt);
    const intent = detectIntent(prompt);

    if (intent) {
      const fromRule = buildPlanFromIntent({
        intent,
        prompt,
        selectorRaw: containerSelector,
        selectorResolution,
        inferred,
        containers,
      });
      if (fromRule.ok) {
        return {
          ok: true,
          code: 0,
          out: "Docker plan created via rule engine.",
          err: "",
          plan: fromRule.plan,
        };
      }
      return { ok: false, code: 1, out: "", err: fromRule.err || "Gagal membuat Docker plan." };
    }

    const fallback = await buildPlanWithCodexFallback({
      prompt,
      selectorRaw: containerSelector,
      containers,
      selectorResolution,
      inferred,
    });

    if (!fallback.ok) {
      return {
        ok: false,
        code: 1,
        out: "",
        err: fallback.err || "Prompt tidak dikenali oleh rule engine maupun fallback.",
      };
    }

    return {
      ok: true,
      code: 0,
      out: "Docker plan created via Codex fallback.",
      err: "",
      plan: fallback.plan,
    };
  }

  function formatPlanPreview(plan) {
    const lines = [
      "Docker plan preview:",
      `- engine: ${plan.engine}`,
      `- intent: ${plan.intent}`,
      `- target: ${plan.targetContainer || "(auto/global)"}`,
      `- read_only: ${plan.readOnly ? "yes" : "no"}`,
      "",
      "Commands:",
      ...(plan.preview?.commands || []).map((c) => `- ${c}`),
    ];

    const notes = plan.preview?.notes || [];
    if (notes.length > 0) {
      lines.push("", "Notes:");
      for (const n of notes) lines.push(`- ${n}`);
    }

    return lines.join("\n");
  }

  async function execDockerPlan(plan) {
    if (!validateExecutionPlan(plan)) {
      return {
        ok: false,
        code: 1,
        out: "",
        err: "Docker plan ditolak oleh safe policy.",
      };
    }

    if (plan.execution.mode === "commands") {
      const chunks = [];
      for (const step of plan.execution.commands) {
        const cmdText = formatCommand(step.cmd, step.args);
        const res = await runCmd(step.cmd, step.args);
        chunks.push(`$ ${cmdText}`);
        if (res.out) chunks.push(res.out);
        if (res.err) chunks.push(res.err);
        chunks.push("");

        if (!res.ok) {
          return {
            ok: false,
            code: res.code,
            out: chunks.join("\n").trim(),
            err: res.err || "Command gagal dieksekusi.",
          };
        }
      }

      return {
        ok: true,
        code: 0,
        out: ["Docker task selesai.", "", chunks.join("\n").trim()].join("\n"),
        err: "",
      };
    }

    if (plan.execution.mode === "restart_if_error") {
      const listed = await runCmd("docker", ["ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"]);
      if (!listed.ok) {
        return {
          ok: false,
          code: listed.code,
          out: listed.out,
          err: listed.err || "Gagal membaca docker ps -a saat eksekusi restart_if_error.",
        };
      }

      const containers = parseDockerPsOutput(listed.out);
      const selector = plan.execution.selectorName ? toLower(plan.execution.selectorName) : null;

      const targets = containers
        .filter((c) => isErrorContainerStatus(c.statusLower))
        .filter((c) => !selector || c.nameLower === selector);

      if (targets.length === 0) {
        return {
          ok: true,
          code: 0,
          out: "Tidak ada container error yang perlu di-restart.",
          err: "",
        };
      }

      const chunks = [`Target restart: ${targets.map((t) => t.name).join(", ")}`, ""];
      for (const target of targets) {
        const res = await runCmd("docker", ["restart", target.name]);
        chunks.push(`$ docker restart ${target.name}`);
        if (res.out) chunks.push(res.out);
        if (res.err) chunks.push(res.err);
        chunks.push("");
        if (!res.ok) {
          return {
            ok: false,
            code: res.code,
            out: chunks.join("\n").trim(),
            err: res.err || `Gagal restart container '${target.name}'.`,
          };
        }
      }

      return {
        ok: true,
        code: 0,
        out: ["Restart-if-error selesai.", "", chunks.join("\n").trim()].join("\n"),
        err: "",
      };
    }

    logLine(`DOCKER_PLAN_UNKNOWN_MODE: ${plan?.execution?.mode}`);
    return {
      ok: false,
      code: 1,
      out: "",
      err: "Mode eksekusi Docker plan tidak dikenal.",
    };
  }

  return {
    planDockerTask,
    formatPlanPreview,
    execDockerPlan,
  };
}

module.exports = {
  createDockerService,
};
