import claude from "./claude.js";

// Local Claude Code login via the Agent SDK. noAuth like opencode/devin-cli: no OAuth connection,
// the CLI's own login is the credential. Tool requests need the `claude` provider instead.
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
      text: "Uses your local Claude Code login. Run `claude auth login` first. No connection needed. Chat only: client tools are not supported.",
    },
  },
  category: "free",
  authType: "none",
  authModes: ["none"],
  transport: {
    baseUrl: "claude-agent-sdk://local-cli",
    format: "claude",
    noAuth: true,
  },
  models: claude.models,
};
