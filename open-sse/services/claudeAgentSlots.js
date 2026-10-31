import { CLAUDE_CLI_MAX_CONCURRENT } from "../config/claudeAgentConstants.js";

let active = 0;
const waiting = []; // { give, cancel } in arrival order

// Resolves with a release function once a CLI slot is free. Rejects if the client aborts while queued.
export function acquireClaudeSlot(signal) {
  if (signal?.aborted) return Promise.reject(new Error("Client aborted before a Claude CLI slot was free"));
  if (active < CLAUDE_CLI_MAX_CONCURRENT) {
    active++;
    return Promise.resolve(releaseClaudeSlot);
  }
  return new Promise((resolve, reject) => {
    const entry = {
      give: () => {
        signal?.removeEventListener("abort", entry.cancel);
        resolve(releaseClaudeSlot);
      },
      cancel: () => {
        waiting.splice(waiting.indexOf(entry), 1);
        reject(new Error("Client aborted while waiting for a Claude CLI slot"));
      },
    };
    signal?.addEventListener("abort", entry.cancel, { once: true });
    waiting.push(entry);
  });
}

// Hands the slot straight to the next waiter, or frees it. Callers must release exactly once.
export function releaseClaudeSlot() {
  const next = waiting.shift();
  if (next) next.give();
  else active--;
}
