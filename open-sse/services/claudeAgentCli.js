import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Explicit CLAUDE_CODE_PATH wins; then PATH (the server may start under launchd/Docker with a bare PATH); then ~/.local/bin.
export function resolveClaudeCli({ configured = "", pathEnv = process.env.PATH, home = os.homedir() } = {}) {
  const explicit = configured.trim();
  if (explicit) return explicit;
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    if (isFile(candidate)) return candidate;
  }
  const local = path.join(home, ".local", "bin", "claude");
  if (isFile(local)) return local;
  throw new Error("Claude Code executable not found. Install Claude Code or set CLAUDE_CODE_PATH.");
}
