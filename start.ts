import { serve } from "@hono/node-server"
import { createProxyServer } from "./src/proxy/server"

const port = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10)
const host = process.env.CLAUDE_PROXY_HOST || "0.0.0.0"

const { app } = createProxyServer({ port, host })

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Claude Max Proxy running at http://${host}:${info.port}`)
})
