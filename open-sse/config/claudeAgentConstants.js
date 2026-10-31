// Claude Agent SDK path: subscription (OAuth) traffic runs through the locally installed Claude Code CLI.
// Set CLAUDE_CODE_PATH when `claude` is not on the PATH of the server process (e.g. launchd, Docker).
export const CLAUDE_AGENT_CLI_PATH = process.env.CLAUDE_CODE_PATH || "claude";
export const CLAUDE_AGENT_URL = "claude-agent-sdk://local-cli";
// Injected by claudeCloaking.applyCloaking() upstream of this executor; the CLI builds its own request, so it must not leak into the system prompt.
export const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
// Content block types that carry no output the local CLI can replay.
export const CLAUDE_AGENT_DROPPED_BLOCKS = new Set(["thinking", "redacted_thinking"]);
// Env the spawned CLI must not inherit: API-key/base-url overrides would bill the key or loop back into 9router,
// and session vars leak from whatever started the server (e.g. a Claude Code shell).
export const CLAUDE_AGENT_ENV_STRIP_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];
export const CLAUDE_AGENT_ENV_STRIP_KEYS = ["CLAUDE_PID", "CLAUDE_EFFORT"];
