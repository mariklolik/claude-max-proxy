import { serve } from "@hono/node-server"
import { createProxyServer } from "./src/proxy/server"

const port = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10)
const host = process.env.CLAUDE_PROXY_HOST || "127.0.0.1"

const { app } = createProxyServer({ port, host })

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Claude Max Proxy v1.2.0 (Node) at http://${host}:${info.port}`)
  console.log(`  Non-streaming: direct CLI spawn (fast path)`)
  console.log(`  Streaming:     SDK query() with SSE`)
  console.log(`  Usage: ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${host}:${info.port} <client>`)
})
