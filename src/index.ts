import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_RETRIES = 3;
const NOTIFY_PREFIX = "[Pi Retry Model]";

interface EmptyResponseResult {
  isEmpty: boolean;
  reason: string;
}

function evaluateEmptyResponse(message: any): EmptyResponseResult {
  if (message.role === "assistant") {
    const hasText = message.content?.some(
      (c: any) => c.type === "text" && c.text.trim().length > 0
    );
    const hasToolCall = message.content?.some(
      (c: any) => c.type === "toolCall"
    );
    const hasThinking = message.content?.some(
      (c: any) => c.type === "thinking" && c.thinking.trim().length > 0
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

  pi.on("agent_settled", async (_event, ctx) => {
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

    if (retryCount >= MAX_RETRIES) {
      ctx.ui.notify(
        `${NOTIFY_PREFIX} Failed to get response after ${MAX_RETRIES} attempts.`,
        "error"
      );
      retryCount = 0;
      return;
    }

    retryCount++;
    ctx.ui.notify(
      `${NOTIFY_PREFIX} ${reason}. Retrying agent run (${retryCount}/${MAX_RETRIES})...`,
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
