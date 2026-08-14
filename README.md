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

## How It Works

1. Listens to the `agent_settled` event when an agent run finishes.
2. Inspects the final message of the active branch.
3. Evaluates if the response was truncated, empty, or halted prematurely.
4. If an empty response is detected (and retries remain), it displays a UI warning notification and automatically dispatches a follow-up message to prompt the model to continue generation.

## License

[MIT](LICENSE)
