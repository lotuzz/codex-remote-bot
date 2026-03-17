const http = require("http");
const https = require("https");

function createOllamaService({ baseUrl, requestTimeoutMs = 10 * 60 * 1000, logLine = () => {} }) {
  const apiBaseUrl = String(baseUrl).trim().replace(/\/+$/, "");

  function buildUrl(pathname) {
    return new URL(String(pathname || "").replace(/^\/+/, ""), `${apiBaseUrl}/`);
  }

  function parseJsonSafe(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function requestJson(method, pathname, body) {
    const url = buildUrl(pathname);
    const transport = url.protocol === "https:" ? https : http;
    const payload = body == null ? "" : JSON.stringify(body);

    return new Promise((resolve) => {
      const req = transport.request(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (res) => {
        let raw = "";

        res.on("data", (chunk) => {
          raw += chunk.toString();
        });

        res.on("end", () => {
          const data = parseJsonSafe(raw);
          const statusCode = Number(res.statusCode) || 0;
          const errText = data?.error || raw || `HTTP ${statusCode}`;
          resolve({
            ok: statusCode >= 200 && statusCode < 300 && !data?.error,
            statusCode,
            data,
            raw: raw.trim(),
            err: errText.trim(),
          });
        });
      });

      req.setTimeout(requestTimeoutMs, () => {
        req.destroy(new Error(`Request timeout after ${requestTimeoutMs}ms`));
      });

      req.on("error", (err) => {
        resolve({
          ok: false,
          statusCode: 0,
          data: null,
          raw: "",
          err: err?.message || String(err),
        });
      });

      if (payload) {
        req.write(payload);
      }

      req.end();
    });
  }

  function formatBytes(n) {
    const value = Number(n);
    if (!Number.isFinite(value) || value < 0) return "-";
    if (value === 0) return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let idx = 0;
    let current = value;
    while (current >= 1024 && idx < units.length - 1) {
      current /= 1024;
      idx += 1;
    }
    const digits = current >= 100 || idx === 0 ? 0 : current >= 10 ? 1 : 2;
    return `${current.toFixed(digits)} ${units[idx]}`;
  }

  function formatModelDetails(model) {
    const details = model?.details || {};
    const parts = [];
    if (details.family) parts.push(details.family);
    if (details.parameter_size) parts.push(details.parameter_size);
    if (details.quantization_level) parts.push(details.quantization_level);
    return parts.join(", ");
  }

  function validateModel(model) {
    const value = String(model || "").trim();
    if (!value) return { ok: false, err: "Model wajib diisi." };
    return { ok: true, value };
  }

  async function pullModel(model) {
    const checked = validateModel(model);
    if (!checked.ok) return { ok: false, code: 1, out: "", err: checked.err };

    logLine(`OLLAMA_PULL model=${checked.value} base=${apiBaseUrl}`);
    const res = await requestJson("POST", "pull", {
      model: checked.value,
      stream: false,
    });

    if (!res.ok) {
      return {
        ok: false,
        code: res.statusCode || 1,
        out: "",
        err: `Ollama pull gagal: ${res.err}`,
      };
    }

    const status = res.data?.status || "success";
    return {
      ok: true,
      code: 0,
      out: [
        "Ollama pull selesai.",
        `- model: ${checked.value}`,
        `- host: ${apiBaseUrl}`,
        `- status: ${status}`,
      ].join("\n"),
      err: "",
    };
  }

  async function listModels() {
    logLine(`OLLAMA_LIST base=${apiBaseUrl}`);
    const res = await requestJson("GET", "tags");

    if (!res.ok) {
      return {
        ok: false,
        code: res.statusCode || 1,
        out: "",
        err: `Ollama list gagal: ${res.err}`,
      };
    }

    const models = Array.isArray(res.data?.models) ? res.data.models : [];
    if (models.length === 0) {
      return {
        ok: true,
        code: 0,
        out: "Ollama list:\n(kosong)",
        err: "",
      };
    }

    const lines = ["Ollama list:"];
    for (const model of models) {
      const name = model?.name || model?.model || "(unknown)";
      const size = formatBytes(model?.size);
      const details = formatModelDetails(model);
      lines.push(`- ${name} | ${size}${details ? ` | ${details}` : ""}`);
    }

    return {
      ok: true,
      code: 0,
      out: lines.join("\n"),
      err: "",
    };
  }

  async function listRunningModels() {
    logLine(`OLLAMA_PS base=${apiBaseUrl}`);
    const res = await requestJson("GET", "ps");

    if (!res.ok) {
      return {
        ok: false,
        code: res.statusCode || 1,
        out: "",
        err: `Ollama ps gagal: ${res.err}`,
      };
    }

    const models = Array.isArray(res.data?.models) ? res.data.models : [];
    if (models.length === 0) {
      return {
        ok: true,
        code: 0,
        out: "Ollama ps:\n(tidak ada model yang sedang running)",
        err: "",
      };
    }

    const lines = ["Ollama ps:"];
    for (const model of models) {
      const name = model?.name || model?.model || "(unknown)";
      const vram = formatBytes(model?.size_vram);
      const ctx = Number.isFinite(Number(model?.context_length)) ? String(model.context_length) : "-";
      const expiresAt = model?.expires_at || "-";
      const details = formatModelDetails(model);
      lines.push(`- ${name} | vram ${vram} | ctx ${ctx} | expires ${expiresAt}${details ? ` | ${details}` : ""}`);
    }

    return {
      ok: true,
      code: 0,
      out: lines.join("\n"),
      err: "",
    };
  }

  async function stopModel(model) {
    const checked = validateModel(model);
    if (!checked.ok) return { ok: false, code: 1, out: "", err: checked.err };

    logLine(`OLLAMA_STOP model=${checked.value} base=${apiBaseUrl}`);
    const res = await requestJson("POST", "generate", {
      model: checked.value,
      prompt: "",
      keep_alive: 0,
      stream: false,
    });

    if (!res.ok) {
      return {
        ok: false,
        code: res.statusCode || 1,
        out: "",
        err: `Ollama stop gagal: ${res.err}`,
      };
    }

    return {
      ok: true,
      code: 0,
      out: [
        "Ollama stop selesai.",
        `- model: ${checked.value}`,
        `- host: ${apiBaseUrl}`,
        `- done: ${String(Boolean(res.data?.done))}`,
        `- reason: ${res.data?.done_reason || "unloaded"}`,
      ].join("\n"),
      err: "",
    };
  }

  async function execTask({ action, model }) {
    if (action === "list") return listModels();
    if (action === "ps") return listRunningModels();
    if (action === "pull") return pullModel(model);
    if (action === "stop") return stopModel(model);

    return {
      ok: false,
      code: 1,
      out: "",
      err: `Action Ollama tidak dikenal: ${action}`,
    };
  }

  function getBaseUrl() {
    return apiBaseUrl;
  }

  return {
    execTask,
    getBaseUrl,
    listModels,
    listRunningModels,
  };
}

module.exports = {
  createOllamaService,
};
