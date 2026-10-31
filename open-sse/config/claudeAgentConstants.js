// Claude Agent SDK path: the locally installed Claude Code CLI serves the request (see services/claudeAgentCli.js).
export const CLAUDE_AGENT_URL = "claude-agent-sdk://local-cli";
// Injected by claudeCloaking.applyCloaking() upstream of this executor; the CLI builds its own request, so it must not leak into the system prompt.
export const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
// Content block types that carry no output the local CLI can replay.
export const CLAUDE_AGENT_DROPPED_BLOCKS = new Set(["thinking", "redacted_thinking"]);
// Env the spawned CLI must not inherit: API-key/base-url overrides would bill the key or loop back into 9router,
// and session vars leak from whatever started the server (e.g. a Claude Code shell).
export const CLAUDE_AGENT_ENV_STRIP_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];
export const CLAUDE_AGENT_ENV_STRIP_KEYS = ["CLAUDE_PID", "CLAUDE_EFFORT"];
// Client tools are exposed as in-process MCP tools on this server; the CLI names them mcp__<server>__<name>.
export const CLAUDE_AGENT_TOOL_SERVER = "client";
export const CLAUDE_AGENT_TOOL_PREFIX = `mcp__${CLAUDE_AGENT_TOOL_SERVER}__`;
export const CLAUDE_AGENT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const CLAUDE_AGENT_REQUIRED_TOOL_INSTRUCTION = "You must call one of the provided tools before answering.";
// Each turn spawns a Claude Code process; cap how many run at once. Extra requests wait in FIFO order.
export const CLAUDE_CLI_MAX_CONCURRENT = Number(process.env.CLAUDE_CLI_MAX_CONCURRENT) || 4;
// Hard limit per turn; a hung CLI is aborted instead of holding its slot forever.
export const CLAUDE_CLI_TURN_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TURN_TIMEOUT_MS) || 300_000;
