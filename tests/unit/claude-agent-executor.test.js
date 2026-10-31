/**
 * Unit tests for open-sse/executors/claude-agent.js and its helpers (claude-cli provider).
 *
 * Covers: transcript rendering (text, images, tool_use/tool_result, thinking dropped), schema conversion,
 * SSE framing and MCP tool-name stripping, error surfacing before the first byte, non-stream assembly,
 * and CLI executable discovery.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleClaudeMessage, buildPrompt, ClaudeAgentExecutor } from "../../open-sse/executors/claude-agent.js";
import { toShape } from "../../open-sse/executors/claudeAgentSchema.js";
import { resolveClaudeCli } from "../../open-sse/services/claudeAgentCli.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
  createSdkMcpServer: ({ name, tools }) => ({ type: "sdk", name, tools }),
}));

async function* fromList(items) {
  for (const item of items) {
    if (item instanceof Error) throw item;
    yield item;
  }
}

const user = (content) => ({ role: "user", content });

describe("buildPrompt", () => {
  it("keeps a single user text turn unlabelled", () => {
    expect(buildPrompt([user("hi")])).toEqual({ text: "hi", images: [] });
  });

  it("labels multi-turn history", () => {
    const { text } = buildPrompt([user("hi"), { role: "assistant", content: "hello" }, user("again")]);
    expect(text).toBe("User: hi\n\nAssistant: hello\n\nUser: again");
  });

  it("renders tool_use and tool_result as text", () => {
    const { text } = buildPrompt([
      user("weather?"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }] },
      user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "18C" }] }]),
    ]);
    expect(text).toContain('Assistant: Assistant called tool get_weather (call t1) with {"city":"Paris"}');
    expect(text).toContain("User: Tool result (call t1): 18C");
  });

  it("collects base64 images and references them by number", () => {
    const source = { type: "base64", media_type: "image/png", data: "AAAA" };
    const { text, images } = buildPrompt([user([{ type: "text", text: "see" }, { type: "image", source }])]);
    expect(text).toBe("see\n[image 1]");
    expect(images).toEqual([source]);
  });

  it("drops thinking blocks from history", () => {
    const messages = [
      user("hi"),
      { role: "assistant", content: [{ type: "thinking", thinking: "...", signature: "s" }, { type: "text", text: "hello" }] },
      user("again"),
    ];
    expect(buildPrompt(messages).text).toBe("User: hi\n\nAssistant: hello\n\nUser: again");
  });
});

describe("toShape", () => {
  it("maps required and optional JSON Schema properties", () => {
    const shape = toShape({
      type: "object",
      properties: { city: { type: "string" }, units: { type: "string", enum: ["c", "f"] } },
      required: ["city"],
    });
    expect(shape.city.safeParse("Paris").success).toBe(true);
    expect(shape.city.safeParse(undefined).success).toBe(false);
    expect(shape.units.safeParse(undefined).success).toBe(true);
    expect(shape.units.safeParse("k").success).toBe(false);
  });
});

describe("resolveClaudeCli", () => {
  it("prefers the explicit path", () => {
    expect(resolveClaudeCli({ configured: " /opt/claude ", pathEnv: "", home: "/nowhere" })).toBe("/opt/claude");
  });

  it("finds claude on PATH, then ~/.local/bin", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-path-"));
    writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n");
    chmodSync(path.join(dir, "claude"), 0o755);
    expect(resolveClaudeCli({ configured: "", pathEnv: dir, home: "/nowhere" })).toBe(path.join(dir, "claude"));

    const home = mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    writeFileSync(path.join(home, ".local", "bin", "claude"), "");
    expect(resolveClaudeCli({ configured: "", pathEnv: "", home })).toBe(path.join(home, ".local", "bin", "claude"));
  });

  it("throws when nothing is found", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "claude-none-"));
    expect(() => resolveClaudeCli({ configured: "", pathEnv: "", home })).toThrow("not found");
  });
});

describe("ClaudeAgentExecutor.execute", () => {
  const body = {
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=1; cc_entrypoint=sdk-cli; cch=abc;" },
      { type: "text", text: "Be brief." },
    ],
    messages: [user("hi")],
  };
  const start = { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } };
  const delta = { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } };
  const result = { type: "result", subtype: "success" };

  it("frames stream_event messages as Anthropic SSE", async () => {
    queryMock.mockReturnValue(fromList([start, delta, result]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "claude-haiku-5-5", body, stream: true });
    const text = await response.text();
    expect(text).toContain('event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n');
    expect(text).toContain("event: content_block_delta\n");
    expect(text).not.toContain("result");
  });

  it("passes CLI options and strips the billing header from the system prompt", async () => {
    queryMock.mockClear();
    queryMock.mockReturnValue(fromList([result]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "claude-haiku-5-5", body, stream: true });
    await response.text();
    const { options } = queryMock.mock.calls.at(-1)[0];
    expect(options.systemPrompt).toBe("Be brief.");
    expect(options.tools).toEqual([]);
    expect(options.model).toBe("claude-haiku-5-5");
    expect(options.maxTurns).toBe(1);
  });

  it("maps output_config.effort to the CLI effort option", async () => {
    queryMock.mockClear();
    queryMock.mockReturnValue(fromList([result]));
    const withEffort = { ...body, output_config: { effort: "high" } };
    const { response } = await new ClaudeAgentExecutor().execute({ model: "m", body: withEffort, stream: true });
    await response.text();
    expect(queryMock.mock.calls.at(-1)[0].options.effort).toBe("high");
  });

  it("exposes client tools as MCP tools and strips the MCP prefix from tool_use names", async () => {
    queryMock.mockClear();
    const tools = [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
    queryMock.mockReturnValue(fromList([
      start,
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "mcp__client__get_weather", input: {} } } },
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } } },
      { type: "stream_event", event: { type: "message_stop" } },
      result,
    ]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "m", body: { ...body, tools }, stream: true });
    const text = await response.text();
    expect(text).toContain('"name":"get_weather"');
    expect(text).not.toContain("mcp__client__");
    const { options } = queryMock.mock.calls.at(-1)[0];
    expect(options.allowedTools).toEqual(["mcp__client__get_weather"]);
    expect(options.mcpServers.client.tools.map((t) => t.name)).toEqual(["get_weather"]);
    expect(options.maxTurns).toBe(2);
  });

  it("rejects before answering when the CLI fails to start", async () => {
    queryMock.mockReturnValue(fromList([new Error("spawn claude ENOENT")]));
    await expect(new ClaudeAgentExecutor().execute({ model: "m", body, stream: true })).rejects.toThrow("ENOENT");
  });

  it("rejects before answering when the CLI reports a logged-out error after init", async () => {
    queryMock.mockReturnValue(fromList([
      { type: "system", subtype: "init" },
      { type: "result", is_error: true, subtype: "error_during_execution" },
    ]));
    await expect(new ClaudeAgentExecutor().execute({ model: "m", body, stream: true })).rejects.toThrow("error_during_execution");
  });

  it("errors the stream when the result reports is_error mid-stream", async () => {
    queryMock.mockReturnValue(fromList([start, { type: "result", is_error: true, subtype: "error_during_execution" }]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "m", body, stream: true });
    await expect(response.text()).rejects.toThrow("error_during_execution");
  });
});

describe("ClaudeAgentExecutor non-stream", () => {
  const body = { messages: [user("hi")] };

  it("answers stream:false with one Claude Message JSON", async () => {
    queryMock.mockReturnValue(fromList([
      { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude-haiku-5-5", usage: { input_tokens: 5, output_tokens: 1 } } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", subtype: "success" },
    ]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "claude-haiku-5-5", body, stream: false });
    expect(response.headers.get("content-type")).toBe("application/json");
    const json = await response.json();
    expect(json).toMatchObject({ id: "m1", type: "message", role: "assistant", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } });
    expect(json.content).toEqual([{ type: "text", text: "Hi!" }]);
  });

  it("throws (no 200) when the CLI fails in non-stream mode", async () => {
    queryMock.mockReturnValue(fromList([{ type: "result", is_error: true, subtype: "error_during_execution" }]));
    await expect(new ClaudeAgentExecutor().execute({ model: "m", body, stream: false })).rejects.toThrow("error_during_execution");
  });

  it("assembleClaudeMessage keeps thinking blocks and signatures", () => {
    const msg = assembleClaudeMessage([
      { type: "message_start", message: { id: "m2", usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    ]);
    expect(msg.content).toEqual([{ type: "thinking", thinking: "hmm", signature: "sig" }]);
  });
});

describe("ClaudeAgentExecutor turn timeout", () => {
  it("aborts a hung CLI turn after CLAUDE_CLI_TURN_TIMEOUT_MS and surfaces a timeout error", async () => {
    vi.useFakeTimers();
    try {
      queryMock.mockImplementation(({ options }) => (async function* () {
        yield { type: "stream_event", event: { type: "message_start", message: { id: "m3" } } };
        await new Promise((resolve) => options.abortController.signal.addEventListener("abort", resolve));
        throw new Error("Operation aborted");
      })());
      const { response } = await new ClaudeAgentExecutor().execute({ model: "m", body: { messages: [user("hi")] }, stream: true });
      const reading = response.text();
      const assertion = expect(reading).rejects.toThrow("timed out after");
      await vi.advanceTimersByTimeAsync(300_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
