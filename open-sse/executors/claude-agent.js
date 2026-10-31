import os from "node:os";
import { randomUUID } from "node:crypto";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { DefaultExecutor } from "./default.js";
import { toShape } from "./claudeAgentSchema.js";
import { resolveClaudeCli } from "../services/claudeAgentCli.js";
import {
  CLAUDE_AGENT_URL,
  CLAUDE_BILLING_HEADER_PREFIX,
  CLAUDE_AGENT_DROPPED_BLOCKS,
  CLAUDE_AGENT_ENV_STRIP_PREFIXES,
  CLAUDE_AGENT_ENV_STRIP_KEYS,
  CLAUDE_AGENT_TOOL_SERVER,
  CLAUDE_AGENT_TOOL_PREFIX,
  CLAUDE_AGENT_EFFORT_LEVELS,
  CLAUDE_AGENT_REQUIRED_TOOL_INSTRUCTION,
  CLAUDE_CLI_TURN_TIMEOUT_MS,
} from "../config/claudeAgentConstants.js";
import { acquireClaudeSlot, releaseClaudeSlot } from "../services/claudeAgentSlots.js";

const SSE_ENCODER = new TextEncoder();
const sseFrame = (event) => SSE_ENCODER.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

function systemText(system) {
  const blocks = typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? system : [];
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string" && !b.text.startsWith(CLAUDE_BILLING_HEADER_PREFIX))
    .map((b) => b.text)
    .join("\n\n");
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" ? b.text : `[unsupported ${b?.type}]`)).join("");
}

// One content block as transcript text. Images are collected and referenced by number.
function renderBlock(block, images) {
  switch (block?.type) {
    case "text":
      return block.text;
    case "image":
      if (block.source?.type !== "base64") return "[unsupported image source]";
      images.push(block.source);
      return `[image ${images.length}]`;
    case "tool_use":
      return `Assistant called tool ${block.name} (call ${block.id}) with ${JSON.stringify(block.input ?? {})}`;
    case "tool_result":
      return `Tool result (call ${block.tool_use_id}): ${resultText(block.content)}`;
    default:
      return CLAUDE_AGENT_DROPPED_BLOCKS.has(block?.type) ? null : `[unsupported ${block?.type}]`;
  }
}

function renderContent(content, images) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => renderBlock(b, images)).filter((line) => line !== null).join("\n");
}

// Flattens the chat into one prompt. A single user turn stays unlabelled; multi-turn gets role labels.
export function buildPrompt(messages) {
  const images = [];
  const turns = messages
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => ({ role: m.role, text: renderContent(m.content, images) }));
  const text = turns.length === 1 && turns[0].role === "user"
    ? turns[0].text
    : turns.map(({ role, text: t }) => `${role === "user" ? "User" : "Assistant"}: ${t}`).join("\n\n");
  return { text, images };
}

// Plain text stays a string prompt; images go in one streaming user message.
function toPrompt({ text, images }) {
  if (images.length === 0) return text;
  return (async function* () {
    yield {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }, ...images.map((source) => ({ type: "image", source }))],
      },
      parent_tool_use_id: null,
    };
  })();
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

// Client tools as in-process MCP tools. The handler only flags the call; execute() ends the turn and the
// client runs the tool on its side.
function toolServer(tools, onCall) {
  return createSdkMcpServer({
    name: CLAUDE_AGENT_TOOL_SERVER,
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description ?? "",
        toShape(t.input_schema ?? { type: "object", properties: {} }),
        async (input) => {
          onCall(input);
          return { content: [{ type: "text", text: "Delegated to client." }] };
        },
      ),
    ),
  });
}

// The CLI reports tool_use names with the MCP prefix; the client knows only its own name.
function toClientEvent(ev) {
  const block = ev.content_block;
  if (ev.type !== "content_block_start" || block?.type !== "tool_use" || !block.name.startsWith(CLAUDE_AGENT_TOOL_PREFIX)) {
    return ev;
  }
  return { ...ev, content_block: { ...block, name: block.name.slice(CLAUDE_AGENT_TOOL_PREFIX.length) } };
}

export class ClaudeAgentExecutor extends DefaultExecutor {
  constructor() {
    super("claude-cli");
  }

  async execute(args) {
    // Queue behind the concurrency cap before spawning anything. The slot is held until the turn's stream ends.
    await acquireClaudeSlot(args.signal);
    let held = true;
    const releaseSlot = () => {
      if (!held) return;
      held = false;
      releaseClaudeSlot();
    };
    try {
      return await this.startTurn(args, releaseSlot);
    } catch (err) {
      releaseSlot();
      throw err;
    }
  }

  async startTurn(args, releaseSlot) {
    const { model, body, stream: wantStream, signal, log } = args;
    const cliPath = resolveClaudeCli({ configured: process.env.CLAUDE_CODE_PATH });
    const prompt = toPrompt(buildPrompt(body.messages ?? []));

    const toolChoice = body.tool_choice?.type;
    const clientTools = toolChoice === "none" ? [] : body.tools ?? [];
    const requireTool = clientTools.length > 0 && (toolChoice === "any" || toolChoice === "tool");
    const effort = body.output_config?.effort;
    const systemPrompt = [systemText(body.system), requireTool ? CLAUDE_AGENT_REQUIRED_TOOL_INSTRUCTION : ""]
      .filter(Boolean)
      .join("\n\n");

    log?.info?.("CLAUDE_AGENT", `route=local-cli tools=${clientTools.length}`);

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let delegated = false; // a client tool call ended the turn
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, CLAUDE_CLI_TURN_TIMEOUT_MS);

    const messages = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        model,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(effort && CLAUDE_AGENT_EFFORT_LEVELS.includes(effort) ? { effort } : {}),
        tools: [],
        ...(clientTools.length > 0
          ? {
              mcpServers: {
                [CLAUDE_AGENT_TOOL_SERVER]: toolServer(clientTools, () => {
                  delegated = true;
                  abortController.abort();
                }),
              },
              allowedTools: clientTools.map((t) => `${CLAUDE_AGENT_TOOL_PREFIX}${t.name}`),
              maxTurns: 2,
            }
          : { maxTurns: 1 }),
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
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      log?.error?.("CLAUDE_AGENT", err.message);
      throw err;
    }

    // Non-stream clients drain the CLI to completion and get one Claude Message JSON.
    // chatCore only forces streaming for PROVIDERS.forceStream, which this provider must not use.
    const events = [];
    let sawMessageDelta = false;
    let sawMessageStop = false;
    const emit = (controller, event) => {
      events.push(event);
      if (event.type === "message_delta") sawMessageDelta = true;
      if (event.type === "message_stop") sawMessageStop = true;
      controller?.enqueue(sseFrame(event));
    };

    const drain = async (controller) => {
      try {
        try {
          for (let next = pending; !next.done; next = await messages.next()) {
            const message = next.value;
            if (message.type === "stream_event") {
              // The abort is delivered after events the CLI already buffered; those belong to the next model turn.
              if (!delegated) emit(controller, toClientEvent(message.event));
            } else if (message.type === "result" && message.is_error) {
              throw new Error(`Claude Agent SDK: ${message.subtype}`);
            }
          }
        } catch (err) {
          // Our own abort after a client tool call is the normal end of that turn.
          if (!timedOut && !(delegated && abortController.signal.aborted)) throw err;
        }
        if (timedOut) throw new Error(`Claude CLI turn timed out after ${CLAUDE_CLI_TURN_TIMEOUT_MS}ms`);
        if (delegated) {
          if (!sawMessageDelta) emit(controller, { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } });
          if (!sawMessageStop) emit(controller, { type: "message_stop" });
        }
        controller?.close();
      } catch (err) {
        log?.error?.("CLAUDE_AGENT", err.message);
        controller?.error(err);
        throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        releaseSlot();
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
        transformedBody: { model },
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
      transformedBody: { model },
    };
  }
}
