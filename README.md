# Claude Max Proxy

A high-performance proxy that turns your Claude Max subscription into a fully Anthropic-compatible API server. Use Claude from any tool that speaks the Anthropic API — OpenCode, custom scripts, the Anthropic Agent SDK — without paying per-token.

Built on the official [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), Hono, and Bun/Node.js.

## Why

Claude Max gives you unlimited Claude access, but only through the CLI and web UI. This proxy exposes your subscription as a standard `/v1/messages` endpoint so any Anthropic-compatible client can use it directly.

## Features

### Session Pool & Prompt Caching
Sessions are kept warm per model and reused across requests. The first request creates the session; subsequent ones resume it, enabling automatic prompt cache hits from the SDK. Real cache metrics are visible in every response:

```json
{
  "usage": {
    "input_tokens": 3,
    "output_tokens": 16,
    "cache_read_input_tokens": 2814,
    "cache_creation_input_tokens": 0
  }
}
```

### Real Token Usage
Actual token counts from the Claude API — not character-based estimates. Input, output, cache read, and cache creation tokens are all tracked and returned in every response.

### Concurrency Control
Configurable request queue with backpressure. Excess requests wait in a FIFO queue; when the queue is full, clients get `503 Retry-After` instead of a crash. Configurable concurrent limit, queue depth, and per-request timeouts with automatic `AbortController` cancellation.

### Rate Limit Detection
Monitors Claude Max rate limit events in real-time. Tracks your 5-hour rolling window utilization and applies proactive backoff before you hit hard limits. Current rate limit state is exposed via `/health` and `/metrics`.

### Model Name Normalization
Accepts 30+ model name formats — shorthand (`sonnet`, `opus`), versioned (`claude-sonnet-4-6`), dated (`claude-sonnet-4-6-20250514`), prefixed (`anthropic/claude-opus-4-6`), legacy (`claude-3-5-sonnet-latest`). All resolve to the right SDK model.

### Intelligent Model Routing
Optional auto-routing (enable with `CLAUDE_PROXY_AUTO_ROUTE=1`): thinking requests go to Opus, short simple messages go to Haiku, everything else uses the requested model.

### Dynamic Tool Registration
Send Anthropic-format `tools` in your request body and Claude can use them. Tools are created as ephemeral MCP servers per request — no configuration needed.

### Extended Thinking
Pass `thinking: { type: "enabled", budget_tokens: 10000 }` in your request. Opus models default to adaptive thinking.

### Native System Prompt
System prompts are passed directly to the SDK's `systemPrompt` option rather than concatenated into the text prompt.

### SDK Feature Pass-Through
The proxy forwards these Anthropic API parameters directly to the SDK:
- `effort` — `"low"`, `"medium"`, `"high"`, `"max"`
- `fallback_model` — automatic model fallback
- `max_budget_usd` — per-request spend cap
- `cwd` — working directory for tool execution
- `thinking` — extended thinking configuration

### Multimodal Support
Image content blocks (base64 and URL) are supported in messages.

### Health & Metrics
- `GET /health` — server status, active/queued requests, session pool state, rate limit info
- `GET /metrics` — request counts by model, duration percentiles (p50/p95/p99), error breakdown, token totals

### Structured Logging
Every request gets a UUID. Logs include timestamps, request IDs, and structured metadata. Configurable log levels via `CLAUDE_PROXY_LOG_LEVEL`.

### Retry with Jitter
Failed SDK queries are retried with exponential jitter. Streaming requests only retry if no content has been sent yet.

## Quick Start

```bash
git clone https://github.com/mariklolik/claude-max-proxy.git
cd claude-max-proxy
npm install

# Start with Bun
bun run start

# Or with Node.js
npx tsx start.ts
```

The proxy starts at `http://127.0.0.1:3456`.

### Use with OpenCode

```bash
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

### Use with the Anthropic SDK

```typescript
import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({
  apiKey: "dummy",
  baseURL: "http://127.0.0.1:3456"
})

const response = await client.messages.create({
  model: "sonnet",
  max_tokens: 1024,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Hello!" }]
})
```

### Use with curl

```bash
# Non-streaming
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "stream": false,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl -N http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "stream": true,
    "system": "Be concise.",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'

# With effort level and thinking
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "stream": false,
    "effort": "high",
    "thinking": {"type": "enabled", "budget_tokens": 10000},
    "messages": [{"role": "user", "content": "Solve this step by step: 15! / 13!"}]
  }'

# With custom tools
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "stream": false,
    "messages": [{"role": "user", "content": "What time is it in Tokyo?"}],
    "tools": [{
      "name": "get_time",
      "description": "Get current time in a timezone",
      "input_schema": {
        "type": "object",
        "properties": {"timezone": {"type": "string"}},
        "required": ["timezone"]
      }
    }]
  }'
```

## Configuration

All settings via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_PROXY_HOST` | `127.0.0.1` | Listen host |
| `CLAUDE_PROXY_MAX_CONCURRENT` | `3` | Max concurrent SDK queries |
| `CLAUDE_PROXY_MAX_QUEUE` | `10` | Max queued requests before 503 |
| `CLAUDE_PROXY_REQUEST_TIMEOUT_MS` | `300000` | Per-request timeout (5 min) |
| `CLAUDE_PROXY_MAX_RETRIES` | `2` | Retry count on query failure |
| `CLAUDE_PROXY_SESSION_TTL_MS` | `600000` | Session pool TTL (10 min) |
| `CLAUDE_PROXY_HEARTBEAT_MS` | `15000` | SSE heartbeat interval |
| `CLAUDE_PROXY_LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `CLAUDE_PROXY_AUTO_ROUTE` | `0` | Enable intelligent model routing |
| `CLAUDE_CODE_EXECUTABLE` | auto-detected | Path to `claude` CLI binary |

## Testing

```bash
# Streaming correctness tests
npx tsx tests/test-streaming.ts

# Dynamic tool tests
npx tsx tests/test-tools.ts

# Load test
npx tsx tests/load-test.ts --concurrent=3 --requests=10 --type=short
```

## Architecture

```
Client Request
  -> Hono HTTP Server
    -> Model Normalization (30+ formats)
    -> Rate Limit Check (proactive backoff)
    -> Request Queue (concurrency control)
      -> Session Pool (acquire warm session)
        -> Claude Agent SDK query()
          -> MCP Servers (opencode tools + dynamic tools)
        <- Stream events / Result
      <- Release session back to pool
    <- Real token usage from SDK
  <- SSE stream or JSON response
```

## Requirements

- Node.js 20+ or Bun
- Claude Max subscription
- `claude` CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

## License

MIT
