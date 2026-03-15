import type { LogLevel } from "../logger"

export interface ProxyConfig {
  port: number
  host: string
  debug: boolean
  maxConcurrent: number
  maxQueue: number
  requestTimeoutMs: number
  maxRetries: number
  logLevel: LogLevel
  heartbeatMs: number
  sessionTtlMs: number
  autoRoute: boolean
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10),
  host: process.env.CLAUDE_PROXY_HOST || "127.0.0.1",
  debug: process.env.CLAUDE_PROXY_DEBUG === "1",
  maxConcurrent: parseInt(process.env.CLAUDE_PROXY_MAX_CONCURRENT || "3", 10),
  maxQueue: parseInt(process.env.CLAUDE_PROXY_MAX_QUEUE || "10", 10),
  requestTimeoutMs: parseInt(process.env.CLAUDE_PROXY_REQUEST_TIMEOUT_MS || "300000", 10),
  maxRetries: parseInt(process.env.CLAUDE_PROXY_MAX_RETRIES || "2", 10),
  logLevel: (process.env.CLAUDE_PROXY_LOG_LEVEL as LogLevel) || "info",
  heartbeatMs: parseInt(process.env.CLAUDE_PROXY_HEARTBEAT_MS || "15000", 10),
  sessionTtlMs: parseInt(process.env.CLAUDE_PROXY_SESSION_TTL_MS || "600000", 10),
  autoRoute: process.env.CLAUDE_PROXY_AUTO_ROUTE === "1",
}
