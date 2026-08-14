import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const DEFAULT_MAX_RETRIES = 3;
const NOTIFY_PREFIX = "[Pi Retry Model]";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "retry-model-config.json");

export interface RetryModelConfig {
  maxRetries: number;
}

export function loadConfig(): RetryModelConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return { maxRetries: DEFAULT_MAX_RETRIES };
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const maxRetries = typeof data.maxRetries === "number" && data.maxRetries >= 0
      ? data.maxRetries
      : DEFAULT_MAX_RETRIES;
    return { maxRetries };
  } catch {
    return { maxRetries: DEFAULT_MAX_RETRIES };
  }
}

export function saveConfig(config: RetryModelConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.error(`${NOTIFY_PREFIX} Failed to save config to ${CONFIG_PATH}:`, err);
  }
}

interface EmptyResponseResult {
  isEmpty: boolean;
  reason: string;
}

export function evaluateEmptyResponse(message: any): EmptyResponseResult {
  if (!message) return { isEmpty: false, reason: "" };

  if (message.role === "assistant") {
    // Errors are handled by Pi core retry; skip API errors
    if (message.errorMessage) return { isEmpty: false, reason: "" };

    // Ignore non-standard stops (e.g. content_filter, max_tokens, etc.) if specified
    if (
      message.stopReason &&
      message.stopReason !== "stop" &&
      message.stopReason !== null &&
      message.stopReason !== "aborted"
    ) {
      return { isEmpty: false, reason: "" };
    }

    const content = Array.isArray(message.content) ? message.content : [];
    const hasText = content.some(
      (c: any) => c.type === "text" && (c.text ?? "").trim().length > 0
    );
    const hasToolCall = content.some(
      (c: any) => c.type === "toolCall" || c.type === "tool_use"
    );
    const hasThinking = content.some(
      (c: any) => c.type === "thinking" && (c.thinking ?? "").trim().length > 0
    );

    if (!hasText && !hasToolCall) {
      return {
        isEmpty: true,
        reason: hasThinking
          ? "Response only contains reasoning/thinking without output text"
          : "Assistant message is empty",
      };
    }
  } else if (message.role === "toolResult") {
    return {
      isEmpty: true,
      reason: "Stopped after tool execution (without assistant reply)",
    };
  }

  return { isEmpty: false, reason: "" };
}

export default function (pi: ExtensionAPI) {
  let retryCount = 0;

  pi.on("session_start", () => {
    retryCount = 0;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const config = loadConfig();
    const maxRetries = config.maxRetries;

    if (maxRetries <= 0) return;

    const entries = ctx.sessionManager.getBranch();
    const messages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);

    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];

    if (lastMessage.role === "assistant" && lastMessage.stopReason === "aborted") {
      retryCount = 0;
      return;
    }

    const { isEmpty, reason } = evaluateEmptyResponse(lastMessage);

    if (!isEmpty) {
      retryCount = 0;
      return;
    }

    if (retryCount >= maxRetries) {
      ctx.ui.notify(
        `${NOTIFY_PREFIX} Failed to get response after ${maxRetries} attempt(s).`,
        "error"
      );
      retryCount = 0;
      return;
    }

    retryCount++;
    ctx.ui.notify(
      `${NOTIFY_PREFIX} ${reason}. Retrying agent run (${retryCount}/${maxRetries})...`,
      "warning"
    );

    pi.sendMessage(
      {
        customType: "model-retry-trigger",
        content: "Continuing generation of truncated response...",
        display: false,
      },
      {
        triggerTurn: true,
        deliverAs: "followUp",
      }
    );
  });
}

