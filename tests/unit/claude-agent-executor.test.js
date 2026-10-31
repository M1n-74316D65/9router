/**
 * Unit tests for open-sse/executors/claude-agent.js (canUseClaudeAgent routing gate)
 *
 * Covers: subscription-only routing, client tools/images falling back to the direct path,
 * and thinking-block dropping.
 */

import { describe, it, expect, vi } from "vitest";
import { assembleClaudeMessage, canUseClaudeAgent, ClaudeAgentExecutor } from "../../open-sse/executors/claude-agent.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

async function* fromList(items) {
  for (const item of items) {
    if (item instanceof Error) throw item;
    yield item;
  }
}

const oauth = { accessToken: "sk-ant-oat01-test" };
const user = (content) => ({ role: "user", content });

describe("canUseClaudeAgent", () => {
  it("routes OAuth connection with plain text messages to the local CLI", () => {
    expect(canUseClaudeAgent({ messages: [user("hi")] }, oauth)).toBe(true);
  });

  it("keeps API-key connections on the direct path", () => {
    expect(canUseClaudeAgent({ messages: [user("hi")] }, { apiKey: "sk-ant-api03-x" })).toBe(false);
  });

  it("falls back when there are no OAuth credentials", () => {
    expect(canUseClaudeAgent({ messages: [user("hi")] }, {})).toBe(false);
  });

  it("falls back when client tools are present", () => {
    const body = { messages: [user("hi")], tools: [{ name: "Read", input_schema: {} }] };
    expect(canUseClaudeAgent(body, oauth)).toBe(false);
  });

  it("falls back on image or tool_result blocks", () => {
    const image = user([{ type: "image", source: {} }]);
    const toolResult = user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
    expect(canUseClaudeAgent({ messages: [image] }, oauth)).toBe(false);
    expect(canUseClaudeAgent({ messages: [toolResult] }, oauth)).toBe(false);
  });

  it("ignores thinking blocks in history", () => {
    const messages = [
      user("hi"),
      { role: "assistant", content: [{ type: "thinking", thinking: "...", signature: "s" }, { type: "text", text: "hello" }] },
      user("again"),
    ];
    expect(canUseClaudeAgent({ messages }, oauth)).toBe(true);
  });
});

describe("ClaudeAgentExecutor.execute", () => {
  const body = {
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=1; cc_entrypoint=sdk-cli; cch=abc;" },
      { type: "text", text: "Be brief." },
    ],
    messages: [{ role: "user", content: "hi" }],
  };
  const credentials = { accessToken: "sk-ant-oat01-test" };
  const delta = { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } };
  const start = { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } };

  it("frames stream_event messages as Anthropic SSE and closes on success", async () => {
    queryMock.mockReturnValue(fromList([start, delta, { type: "result", subtype: "success" }]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "claude-haiku-4-5-20251001", body, stream: true, credentials });
    const text = await response.text();
    expect(text).toContain('event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n');
    expect(text).toContain('event: content_block_delta\n');
    expect(text).not.toContain("result");
  });

  it("passes CLI options and strips the billing header from the system prompt", async () => {
    queryMock.mockReturnValue(fromList([{ type: "result", subtype: "success" }]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "claude-haiku-4-5-20251001", body, stream: true, credentials });
    await response.text();
    const { options } = queryMock.mock.calls.at(-1)[0];
    expect(options.systemPrompt).toBe("Be brief.");
    expect(options.tools).toEqual([]);
    expect(options.model).toBe("claude-haiku-4-5-20251001");
  });

  it("rejects before answering when the CLI fails to start", async () => {
    queryMock.mockReturnValue(fromList([new Error("spawn claude ENOENT")]));
    await expect(new ClaudeAgentExecutor().execute({ model: "m", body, credentials })).rejects.toThrow("ENOENT");
  });

  it("rejects before answering when the CLI reports a logged-out error after init", async () => {
    queryMock.mockReturnValue(fromList([
      { type: "system", subtype: "init" },
      { type: "result", is_error: true, subtype: "error_during_execution" },
    ]));
    await expect(new ClaudeAgentExecutor().execute({ model: "m", body, credentials })).rejects.toThrow("error_during_execution");
  });

  it("errors the stream when the result reports is_error", async () => {
    queryMock.mockReturnValue(fromList([start, { type: "result", is_error: true, subtype: "error_during_execution" }]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "m", body, stream: true, credentials });
    await expect(response.text()).rejects.toThrow("error_during_execution");
  });
});

describe("ClaudeAgentExecutor non-stream", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const credentials = { accessToken: "sk-ant-oat01-test" };

  it("answers stream:false with one Claude Message JSON", async () => {
    queryMock.mockReturnValue(fromList([
      { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 5, output_tokens: 1 } } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", subtype: "success" },
    ]));
    const { response } = await new ClaudeAgentExecutor().execute({ model: "claude-haiku-4-5-20251001", body, stream: false, credentials });
    expect(response.headers.get("content-type")).toBe("application/json");
    const json = await response.json();
    expect(json).toMatchObject({ id: "m1", type: "message", role: "assistant", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } });
    expect(json.content).toEqual([{ type: "text", text: "Hi!" }]);
  });

  it("throws (no 200) when the CLI fails in non-stream mode", async () => {
    queryMock.mockReturnValue(fromList([{ type: "result", is_error: true, subtype: "error_during_execution" }]));
    await expect(new ClaudeAgentExecutor().execute({ model: "m", body, stream: false, credentials })).rejects.toThrow("error_during_execution");
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
