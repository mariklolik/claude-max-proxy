import { randomUUID } from "crypto"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const configuredLevel: LogLevel = (process.env.CLAUDE_PROXY_LOG_LEVEL as LogLevel) || "info"

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLevel]
}

function formatLog(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString()
  const requestId = meta?.requestId || "-"
  const metaStr = meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : ""
  return `[${timestamp}] [${requestId}] [${level.toUpperCase()}] ${message}${metaStr}`
}

export function generateRequestId(): string { return randomUUID() }

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return
  const line = formatLog(level, message, meta)
  switch (level) {
    case "debug": console.debug(line); break
    case "info": console.info(line); break
    case "warn": console.warn(line); break
    case "error": console.error(line); break
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
}

export const claudeLog = (message: string, extra?: Record<string, unknown>) => logger.debug(message, extra)
