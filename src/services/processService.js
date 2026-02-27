const { spawn } = require("child_process");

function createProcessService({ logLine }) {
  function runCmd(cmd, args, opts = {}) {
    logLine(`RUN: ${cmd} ${args.join(" ")}`);
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { windowsHide: true, ...opts });
      let out = "";
      let err = "";

      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.stderr.on("data", (d) => {
        err += d.toString();
      });

      child.on("error", (e) => {
        resolve({ ok: false, code: -1, out: out.trim(), err: (e?.message || String(e)).trim() });
      });
      child.on("close", (code) => {
        resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() });
      });
    });
  }

  return {
    runCmd,
  };
}

module.exports = {
  createProcessService,
};

