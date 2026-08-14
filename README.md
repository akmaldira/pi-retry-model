# pi-retry-model

An extension for [Pi Coding Agent](https://github.com/earendil-works/pi) that automatically retries execution when a model returns an incomplete or empty response.

## Features

- **Empty Assistant Response Handling**: Detects when an assistant message yields no output text and no tool calls.
- **Thinking-Only Response Recovery**: Triggers auto-retry when a model emits reasoning/thinking blocks but stops before producing output text.
- **Tool Result Only Recovery**: Handles edge cases where execution halts right after tool execution without an assistant follow-up.
- **Aborted Run Awareness**: Automatically skips retries when a run is manually cancelled (e.g., via `ESC` key).
- **Max Retry Threshold**: Caps retries at 3 attempts per occurrence to avoid infinite retry loops.

## Installation

Install directly via Pi:

```bash
pi install npm:pi-retry-model
```

Or test temporarily in a single session:

```bash
pi -e npm:pi-retry-model
```

## Configuration

The extension automatically creates and reads its configuration from `~/.pi/agent/retry-model-config.json`:

```json
{
  "maxRetries": 3
}
```

- **`maxRetries`**: Maximum number of auto-retry attempts per empty response occurrence (default: `3`, set to `0` to disable).

## How It Works

1. Listens to the `agent_settled` event when an agent run finishes.
2. Inspects the final message of the active branch.
3. Evaluates if the response was truncated, empty, or halted prematurely.
4. If an empty response is detected (and retries remain), it displays a UI warning notification and automatically dispatches a follow-up message to prompt the model to continue generation.

### Why `agent_settled` instead of `agent_end`?

Pi provides two lifecycle events when an agent run completes:

- **`agent_end`**: Emitted immediately when a single low-level agent loop finishes. At this point, Pi core may still perform automatic retries, context compaction, or process queued follow-up messages.
- **`agent_settled`**: Emitted only when the agent run is completely idle and no automatic retries, compaction, or follow-ups remain.

This extension uses `agent_settled` to:
- **Prevent race conditions**: Ensures Pi core finish any built-in compaction or retry tasks before triggering a new turn.
- **Avoid duplicate retries**: Guarantees that retries only run when Pi has genuinely stopped and will not automatically continue on its own.

## License

[MIT](LICENSE)
