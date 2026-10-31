import os from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DefaultExecutor } from "./default.js";
import {
  CLAUDE_AGENT_CLI_PATH,
  CLAUDE_AGENT_URL,
  CLAUDE_BILLING_HEADER_PREFIX,
  CLAUDE_AGENT_DROPPED_BLOCKS,
  CLAUDE_AGENT_ENV_STRIP_PREFIXES,
  CLAUDE_AGENT_ENV_STRIP_KEYS,
} from "../config/claudeAgentConstants.js";

const SSE_ENCODER = new TextEncoder();

function blockText(block) {
  return block?.type === "text" && typeof block.text === "string" ? block.text : null;
}

// Returns the message's plain text, or null when it carries blocks the local CLI cannot replay (tools, images).
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (CLAUDE_AGENT_DROPPED_BLOCKS.has(block?.type)) continue;
    const text = blockText(block);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join("\n");
}

function systemText(system) {
  const blocks = typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? system : [];
  return blocks
    .map(blockText)
    .filter((text) => text && !text.startsWith(CLAUDE_BILLING_HEADER_PREFIX))
    .join("\n\n");
}

// Flattens the chat into one prompt. Single user turn passes through unlabelled; multi-turn gets role labels.
function buildPrompt(messages) {
  const turns = [];
  for (const msg of messages) {
    if (msg?.role !== "user" && msg?.role !== "assistant") continue;
    const text = messageText(msg.content);
    if (text === null) return null;
    turns.push({ role: msg.role, text });
  }
  if (turns.length === 1 && turns[0].role === "user") return turns[0].text;
  return turns.map(({ role, text }) => `${role === "user" ? "User" : "Assistant"}: ${text}`).join("\n\n");
}

// Env for the spawned CLI: the server's env minus API-key/base-url overrides and inherited session vars.
export function buildClaudeAgentEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (CLAUDE_AGENT_ENV_STRIP_KEYS.includes(key)) continue;
    if (CLAUDE_AGENT_ENV_STRIP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

// Client tools and images are not replayable through the CLI yet: those requests are rejected here.
// Returns the rejection reason, or null when the request goes through the local CLI.
export function claudeAgentFallbackReason(body) {
  if (Array.isArray(body?.tools) && body.tools.length > 0) return "client-tools";
  if (!Array.isArray(body?.messages) || buildPrompt(body.messages) === null) return "non-text-content";
  return null;
}

export function canUseClaudeAgent(body) {
  return claudeAgentFallbackReason(body) === null;
}

// Rebuilds a non-stream Claude Message from the raw stream events the CLI emitted.
export function assembleClaudeMessage(events) {
  const message = { type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: {} };
  for (const ev of events) {
    if (ev.type === "message_start") {
      Object.assign(message, ev.message, { content: [] });
    } else if (ev.type === "content_block_start") {
      message.content[ev.index] = { ...ev.content_block };
    } else if (ev.type === "content_block_delta") {
      const block = message.content[ev.index];
      if (!block) continue;
      if (ev.delta.type === "text_delta") block.text = (block.text ?? "") + ev.delta.text;
      else if (ev.delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + ev.delta.thinking;
      else if (ev.delta.type === "signature_delta") block.signature = ev.delta.signature;
    } else if (ev.type === "message_delta") {
      message.stop_reason = ev.delta?.stop_reason ?? message.stop_reason;
      message.stop_sequence = ev.delta?.stop_sequence ?? null;
      message.usage = { ...message.usage, ...ev.usage };
    }
  }
  message.content = message.content.filter(Boolean);
  return message;
}

export class ClaudeAgentExecutor extends DefaultExecutor {
  constructor() {
    super("claude-cli");
  }

  async execute(args) {
    const { model, body, stream: wantStream, signal, log } = args;
    const rejectReason = claudeAgentFallbackReason(body);
    if (rejectReason) {
      log?.info?.("CLAUDE_AGENT", `route=reject reason=${rejectReason}`);
      throw new Error(`claude-cli does not support ${rejectReason}; use provider "claude" for tool requests`);
    }
    log?.info?.("CLAUDE_AGENT", "route=local-cli");

    const prompt = buildPrompt(body.messages);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const messages = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: CLAUDE_AGENT_CLI_PATH,
        model,
        systemPrompt: systemText(body.system),
        tools: [],
        maxTurns: 1,
        permissionMode: "default",
        settingSources: [],
        strictMcpConfig: true,
        includePartialMessages: true,
        env: buildClaudeAgentEnv(),
        cwd: os.tmpdir(),
        abortController,
      },
    })[Symbol.asyncIterator]();

    // Wait for the first stream_event before answering. Spawn, auth ("Not logged in") and early error
    // results throw here, so chatCore returns a 502 result (handled by the account loop) instead of a 200 with a broken SSE body.
    let pending;
    try {
      for (;;) {
        pending = await messages.next();
        if (pending.done || pending.value.type === "stream_event") break;
        if (pending.value.type === "result" && pending.value.is_error) {
          throw new Error(`Claude Agent SDK: ${pending.value.subtype}`);
        }
      }
    } catch (err) {
      signal?.removeEventListener("abort", onAbort);
      log?.error?.("CLAUDE_AGENT", err.message);
      throw err;
    }

    // Non-stream clients: drain the CLI to completion and answer with one Claude Message JSON.
    // chatCore only forces streaming for PROVIDERS.forceStream, which this provider must not use.
    const events = [];
    const drain = async (controller) => {
      try {
        for (let next = pending; !next.done; next = await messages.next()) {
          const message = next.value;
          if (message.type === "stream_event") {
            events.push(message.event);
            controller?.enqueue(SSE_ENCODER.encode(`event: ${message.event.type}\ndata: ${JSON.stringify(message.event)}\n\n`));
          } else if (message.type === "result" && message.is_error) {
            throw new Error(`Claude Agent SDK: ${message.subtype}`);
          }
        }
        controller?.close();
      } catch (err) {
        log?.error?.("CLAUDE_AGENT", err.message);
        controller?.error(err);
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    };

    if (wantStream === false) {
      await drain(null);
      return {
        response: new Response(JSON.stringify(assembleClaudeMessage(events)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: CLAUDE_AGENT_URL,
        headers: {},
        transformedBody: { model, promptLength: prompt.length },
      };
    }

    const sseBody = new ReadableStream({
      start(controller) {
        // Errors are delivered through controller.error(); the promise is only observed here.
        drain(controller).catch(() => {});
      },
      cancel() {
        abortController.abort();
        signal?.removeEventListener("abort", onAbort);
      },
    });

    return {
      response: new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      }),
      url: CLAUDE_AGENT_URL,
      headers: {},
      transformedBody: { model, promptLength: prompt.length },
    };
  }
}
