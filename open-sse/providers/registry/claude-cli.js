// Local Claude Code login via the Agent SDK. noAuth like opencode/devin-cli: no OAuth connection,
// the CLI's own login is the credential.
export default {
  id: "claude-cli",
  priority: 11,
  alias: "ccl",
  uiAlias: "ccl",
  display: {
    name: "Claude Code (local)",
    icon: "smart_toy",
    color: "#D97757",
    website: "https://claude.ai",
    notice: {
      text: "Uses your local Claude Code login. Run `claude auth login` first. No connection needed. Client tools supported.",
    },
  },
  category: "free",
  authType: "none",
  // Top-level flag: buildProviderEntry() and the credential injector read r.noAuth here,
  // not the copy inside transport. Without it: no ccl/* models, "No active credentials".
  noAuth: true,
  authModes: ["none"],
  transport: {
    baseUrl: "claude-agent-sdk://local-cli",
    format: "claude",
    noAuth: true,
  },
  // Pinned ids, verified with `claude --model <id>`. Fable is left out: it needs usage credits.
  models: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  ],
};
