const fs = require("fs");

function createSysService({ runCmd, resolveWorkspace, repoMap, allowGitFreeform, ensureDir }) {
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
          out: [
            "docker --version:",
            a.out || a.err || "(no output)",
            "",
            "docker compose version:",
            b.out || b.err || "(no output)",
          ].join("\n"),
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
        if (!url && !allowGitFreeform) {
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

  return {
    sysHelp,
    execSysTask,
  };
}

module.exports = {
  createSysService,
};

