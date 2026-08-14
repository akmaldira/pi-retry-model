import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import defaultExtension, { evaluateEmptyResponse, loadConfig, saveConfig } from "../src/index.ts";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

describe("loadConfig and saveConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loadConfig returns DEFAULT_MAX_RETRIES if config file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadConfig()).toEqual({ maxRetries: 3 });
  });

  it("loadConfig returns parsed maxRetries if valid config file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ maxRetries: 5 }) as any);
    expect(loadConfig()).toEqual({ maxRetries: 5 });
  });

  it("loadConfig falls back to DEFAULT_MAX_RETRIES on invalid data or read error", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("Read error");
    });
    expect(loadConfig()).toEqual({ maxRetries: 3 });
  });

  it("saveConfig writes formatted JSON to CONFIG_PATH", () => {
    saveConfig({ maxRetries: 2 });
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ maxRetries: 2 }, null, 2),
      "utf8"
    );
  });
});

describe("evaluateEmptyResponse", () => {
  it("returns non-empty for non-assistant messages except toolResult", () => {
    expect(evaluateEmptyResponse({ role: "user", content: [] })).toEqual({
      isEmpty: false,
      reason: "",
    });
  });

  it("identifies empty assistant message without text or tool calls", () => {
    const res = evaluateEmptyResponse({
      role: "assistant",
      content: [],
    });
    expect(res.isEmpty).toBe(true);
    expect(res.reason).toContain("Assistant message is empty");
  });

  it("identifies thinking-only assistant message", () => {
    const res = evaluateEmptyResponse({
      role: "assistant",
      content: [{ type: "thinking", thinking: "Analyzing code..." }],
    });
    expect(res.isEmpty).toBe(true);
    expect(res.reason).toContain("Response only contains reasoning/thinking");
  });

  it("detects tool calls via toolCalls property or content items (toolCall, tool_use, tool_call, functionCall)", () => {
    const withProp = evaluateEmptyResponse({
      role: "assistant",
      toolCalls: [{ name: "bash" }],
      content: [],
    });
    expect(withProp.isEmpty).toBe(false);

    for (const toolType of ["toolCall", "tool_use", "tool_call", "functionCall"]) {
      const withContent = evaluateEmptyResponse({
        role: "assistant",
        content: [{ type: toolType, name: "read" }],
      });
      expect(withContent.isEmpty).toBe(false);
    }
  });

  it("identifies toolResult role as empty (waiting for assistant reply)", () => {
    const res = evaluateEmptyResponse({ role: "toolResult" });
    expect(res.isEmpty).toBe(true);
    expect(res.reason).toContain("Stopped after tool execution");
  });

  it("ignores messages with error message or non-standard stop reasons", () => {
    const withError = evaluateEmptyResponse({
      role: "assistant",
      errorMessage: "API Rate limit",
      content: [],
    });
    expect(withError.isEmpty).toBe(false);

    const withMaxTokens = evaluateEmptyResponse({
      role: "assistant",
      stopReason: "max_tokens",
      content: [],
    });
    expect(withMaxTokens.isEmpty).toBe(false);
  });

  it("allows stopReason = aborted to be evaluated as empty by evaluateEmptyResponse but stopReason stop or null is supported", () => {
    const withAborted = evaluateEmptyResponse({
      role: "assistant",
      stopReason: "aborted",
      content: [],
    });
    expect(withAborted.isEmpty).toBe(true);
  });
});

describe("Extension retry logic & session scoping", () => {
  let handlers: Record<string, Function> = {};
  let commandHandler: Function | undefined;
  let mockPi: any;
  let mockCtx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    handlers = {};
    commandHandler = undefined;
    mockPi = {
      registerCommand: vi.fn((name: string, config: any) => {
        if (name === "retry-model-config") {
          commandHandler = config.handler;
        }
      }),
      on: vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
      sendMessage: vi.fn(),
    };
    mockCtx = {
      ui: { notify: vi.fn() },
      sessionManager: {
        getSessionId: vi.fn().mockReturnValue("session-1"),
        getBranch: vi.fn().mockReturnValue([
          { type: "message", message: { role: "assistant", content: [] } },
        ]),
      },
    };
    defaultExtension(mockPi);
  });

  describe("retry-model-config command", () => {
    it("notifies current max retries when no args provided", async () => {
      await commandHandler?.("", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Current max retries: 3"),
        "info"
      );
    });

    it("notifies error on invalid input", async () => {
      await commandHandler?.("abc", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid input "abc"'),
        "error"
      );

      await commandHandler?.("-1", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid input "-1"'),
        "error"
      );
    });

    it("updates maxRetries on valid non-negative integer", async () => {
      await commandHandler?.("5", mockCtx);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify({ maxRetries: 5 }, null, 2),
        "utf8"
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Max retries updated to 5"),
        "info"
      );
    });
  });

  it("handles empty or missing branch/messages gracefully", async () => {
    mockCtx.sessionManager.getBranch.mockReturnValue([]);
    await handlers["agent_settled"]({}, mockCtx);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("resets retry counter on successful non-empty response", async () => {
    mockCtx.sessionManager.getSessionId.mockReturnValue("session-1");
    // Attempt 1: empty response
    await handlers["agent_settled"]({}, mockCtx);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

    // Subsequent settled: non-empty message received
    mockCtx.sessionManager.getBranch.mockReturnValue([
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] } },
    ]);
    await handlers["agent_settled"]({}, mockCtx);

    // Counter cleared; next empty response should trigger (1/3)
    mockCtx.sessionManager.getBranch.mockReturnValue([
      { type: "message", message: { role: "assistant", content: [] } },
    ]);
    await handlers["agent_settled"]({}, mockCtx);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockCtx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("(1/3)"),
      "warning"
    );
  });

  it("respects maxRetries limit and notifies error when exceeded", async () => {
    mockCtx.sessionManager.getSessionId.mockReturnValue("session-limit");
    // Attempt 1
    await handlers["agent_settled"]({}, mockCtx);
    // Attempt 2
    await handlers["agent_settled"]({}, mockCtx);
    // Attempt 3
    await handlers["agent_settled"]({}, mockCtx);

    expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);

    // Attempt 4 should hit limit error notification and stop retrying
    await handlers["agent_settled"]({}, mockCtx);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);
    expect(mockCtx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Failed to get response after 3 attempt(s)."),
      "error"
    );
  });

  it("does not retry if maxRetries is configured to 0 (disabled)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ maxRetries: 0 }) as any);

    await handlers["agent_settled"]({}, mockCtx);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("handles aborted stopReason by clearing retry count and not sending retry message", async () => {
    mockCtx.sessionManager.getBranch.mockReturnValue([
      { type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } },
    ]);

    await handlers["agent_settled"]({}, mockCtx);

    expect(mockPi.sendMessage).not.toHaveBeenCalled();
  });

  it("tracks retry counts per session ID", async () => {
    // Session 1 empty response triggers retry 1
    mockCtx.sessionManager.getSessionId.mockReturnValue("session-1");
    await handlers["agent_settled"]({}, mockCtx);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

    // Session 2 empty response triggers retry 1 independently
    mockCtx.sessionManager.getSessionId.mockReturnValue("session-2");
    await handlers["agent_settled"]({}, mockCtx);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);

    // Reset session 1 via session_start
    mockCtx.sessionManager.getSessionId.mockReturnValue("session-1");
    handlers["session_start"]({}, mockCtx);

    // Session 1 next settled should be attempt 1 again
    await handlers["agent_settled"]({}, mockCtx);
    expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);
    expect(mockCtx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("(1/3)"),
      "warning"
    );
  });
});

