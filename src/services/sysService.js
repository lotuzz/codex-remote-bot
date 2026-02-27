function createSysService({ runCmd, resolveWorkspace }) {
  function fmtBytes(n) {
    const v = Number(n) || 0;
    const gb = v / (1024 ** 3);
    return `${gb.toFixed(1)}GB`;
  }

  function sysHelp() {
    return [
      "SYS tasks:",
      "/sys reboot",
      "/sys memory",
      "",
      "GIT ops:",
      "/sys repo_pull <alias>",
      "/sys repo_status <alias>",
      "",
      "Semua /sys butuh konfirmasi: /confirm <kode>",
    ].join("\n");
  }

  async function execSysTask(task, arg1) {
    switch (task) {
      case "reboot":
        return runCmd("shutdown", ["/r", "/t", "0"]);

      case "memory": {
        const os = require("os");
        const total = os.totalmem();
        const free = os.freemem();
        const used = Math.max(total - free, 0);
        const usedPct = total > 0 ? ((used / total) * 100).toFixed(1) : "0.0";
        return {
          ok: true,
          code: 0,
          out: [
            "Memory usage:",
            `- RAM: ${fmtBytes(used)}/${fmtBytes(total)} (${usedPct}%)`,
            `- free: ${fmtBytes(free)}`,
            `- host: ${os.hostname()}`,
            `- platform: ${os.platform()} ${os.release()}`,
          ].join("\n"),
          err: "",
        };
      }

      // ---- Git ops ----
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
