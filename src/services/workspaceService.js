const path = require("path");

function createWorkspaceService({ workspaceMap, applicationsDir, logLine }) {
  function resolveWorkspace(alias) {
    const raw = workspaceMap[alias];
    if (!raw) return null;

    const abs = path.resolve(raw);
    const appsRoot = path.resolve(applicationsDir);

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

  function formatWorkspaceList() {
    return Object.entries(workspaceMap).map(([k, v]) => `- ${k} => ${v}`).join("\n") || "(set CODEX_WORKSPACES di .env)";
  }

  return {
    resolveWorkspace,
    formatWorkspaceList,
  };
}

module.exports = {
  createWorkspaceService,
};

