import { Hono } from "hono"
import { cors } from "hono/cors"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "hono"
import type { ProxyConfig } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { logger, generateRequestId } from "../logger"
import { execSync } from "child_process"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { createOpencodeMcpServer } from "../mcpTools"
import { createWeatherMcpServer } from "../tools/weather-server"
import { RequestQueue, QueueFullError, TimeoutError } from "./queue"
import { metrics } from "./metrics"
import { createDynamicToolServer } from "./tools"
import { mapThinkingConfig } from "./thinking"
import { SessionPool } from "./session-pool"
import { normalizeModel, autoRouteModel } from "./model-router"
import { rateLimiter } from "./rate-limiter"

const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
]

const MCP_SERVER_NAME = "opencode"
const CUSTOM_MCP_NAME = "custom"

const ALLOWED_MCP_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`,
  `mcp__${CUSTOM_MCP_NAME}__get_weather`,
  `mcp__${CUSTOM_MCP_NAME}__calculate`,
]

function resolveClaudeExecutable(): string {
  if (process.env.CLAUDE_CODE_EXECUTABLE && existsSync(process.env.CLAUDE_CODE_EXECUTABLE)) {
    return process.env.CLAUDE_CODE_EXECUTABLE
  }
  try {
    const claudePath = execSync("which claude", { encoding: "utf-8" }).trim()
    if (claudePath && existsSync(claudePath)) return claudePath
  } catch {}
  try {
    const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
    const sdkCliJs = join(dirname(sdkPath), "cli.js")
    if (existsSync(sdkCliJs)) return sdkCliJs
  } catch {}
  throw new Error("Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code")
}

const claudeExecutable = resolveClaudeExecutable()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitter(baseMs: number): number {
  return baseMs + Math.random() * baseMs * 0.5
}

/**
 * Extract system prompt from Anthropic API format.
 * Returns the text to pass as SDK systemPrompt option.
 */
function extractSystemPrompt(system: unknown): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    const text = system
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n")
    return text || undefined
  }
  return undefined
}

/**
 * Convert Anthropic API messages to a text prompt for the SDK.
 * Handles multimodal content (text + images).
 */
function buildPromptFromMessages(
  messages: Array<{ role: string; content: string | Array<any> }> | undefined
): string {
  if (!messages) return ""

  return messages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "Human"
      let content: string

      if (typeof m.content === "string") {
        content = m.content
      } else if (Array.isArray(m.content)) {
        // Process all content blocks including images
        const parts: string[] = []
        for (const block of m.content) {
          if (block.type === "text" && block.text) {
            parts.push(block.text)
          } else if (block.type === "image") {
            // Image blocks are passed as description references
            // The SDK handles images through the content blocks in the prompt
            const source = block.source
            if (source?.type === "base64") {
              parts.push(`[Image: ${source.media_type}, ${Math.round((source.data?.length || 0) * 3 / 4 / 1024)}KB base64]`)
            } else if (source?.type === "url") {
              parts.push(`[Image: ${source.url}]`)
            }
          }
        }
        content = parts.join("")
      } else {
        content = String(m.content)
      }
      return `${role}: ${content}`
    })
    .join("\n\n")
}

/**
 * Calculate total message length for routing decisions.
 */
function totalMessageLength(messages: Array<{ content: string | Array<any> }> | undefined): number {
  if (!messages) return 0
  let len = 0
  for (const m of messages) {
    if (typeof m.content === "string") {
      len += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text") len += (block.text || "").length
      }
    }
  }
  return len
}

/**
 * Check if messages contain any image content blocks.
 */
function hasImageContent(messages: Array<{ content: string | Array<any> }> | undefined): boolean {
  if (!messages) return false
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      if (m.content.some((b: any) => b.type === "image")) return true
    }
  }
  return false
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const app = new Hono()
  const requestQueue = new RequestQueue({
    maxConcurrent: finalConfig.maxConcurrent,
    maxQueue: finalConfig.maxQueue,
    requestTimeoutMs: finalConfig.requestTimeoutMs,
  })
  const sessionPool = new SessionPool({ ttlMs: finalConfig.sessionTtlMs })

  app.use("*", cors())

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "claude-max-proxy",
      version: "1.1.0",
      format: "anthropic",
      endpoints: ["/v1/messages", "/messages", "/health", "/metrics"],
      features: [
        "session-pool", "real-token-usage", "native-system-prompt",
        "model-routing", "rate-limit-detection", "cache-control",
        "multimodal", "dynamic-tools", "extended-thinking",
        "effort-levels", "fallback-model", "budget-caps",
      ],
    })
  })

  app.get("/health", (c) => {
    metrics.setActiveRequests(requestQueue.active)
    metrics.setQueuedRequests(requestQueue.queued)
    const poolStats = sessionPool.stats()
    return c.json({
      ...metrics.getHealth(),
      sessionPool: poolStats,
      rateLimit: rateLimiter.getInfo(),
    })
  })

  app.get("/metrics", (c) => {
    metrics.setActiveRequests(requestQueue.active)
    metrics.setQueuedRequests(requestQueue.queued)
    return c.json({
      ...metrics.getMetrics() as object,
      session_pool: sessionPool.stats(),
      rate_limit: rateLimiter.getInfo(),
    })
  })

  const handleMessages = async (c: Context) => {
    const requestId = generateRequestId()
    const startTime = Date.now()

    try {
      const body = await c.req.json()
      const stream = body.stream ?? true

      // --- Model normalization + intelligent routing ---
      const normalizedModel = normalizeModel(body.model || "sonnet")
      const model = autoRouteModel(normalizedModel, {
        hasThinking: !!body.thinking && body.thinking.type !== "disabled",
        toolCount: body.tools?.length || 0,
        messageLength: totalMessageLength(body.messages),
        messageCount: body.messages?.length || 0,
        hasImages: hasImageContent(body.messages),
      })

      if (model !== normalizedModel) {
        logger.info("model.routed", { requestId, requested: body.model, normalized: normalizedModel, routed: model })
      }

      logger.info("request.received", { requestId, model, stream, messageCount: body.messages?.length })

      // --- Rate limit check (proactive backoff) ---
      const throttle = rateLimiter.shouldThrottle()
      if (throttle === "reject") {
        const info = rateLimiter.getInfo()
        return c.json(
          { type: "error", error: { type: "rate_limit_error", message: "Rate limited, please wait" } },
          429,
          {
            "X-Request-ID": requestId,
            "Retry-After": info.resetsAt ? String(Math.ceil(info.resetsAt - Date.now() / 1000)) : "60",
          }
        )
      }
      if (typeof throttle === "number") {
        logger.info("ratelimit.backoff", { requestId, delayMs: throttle })
        await sleep(throttle)
      }

      // --- Native system prompt ---
      const systemPrompt = extractSystemPrompt(body.system)

      // --- Build text prompt from messages ---
      const prompt = buildPromptFromMessages(body.messages)

      // --- Dynamic tools ---
      const dynamicTools = createDynamicToolServer(body.tools)
      const allowedTools = [...ALLOWED_MCP_TOOLS]
      const mcpServers: Record<string, any> = {
        [MCP_SERVER_NAME]: createOpencodeMcpServer(),
        [CUSTOM_MCP_NAME]: createWeatherMcpServer(),
      }
      if (dynamicTools) {
        mcpServers[dynamicTools.mcpName] = dynamicTools.server
        allowedTools.push(...dynamicTools.toolNames)
      }

      // --- Extended thinking ---
      const thinkingConfig = mapThinkingConfig(body.thinking, body.model || "sonnet")

      // --- Session pool: try to reuse a warm session ---
      const resumeSessionId = sessionPool.acquire(model)

      // --- Build SDK query options ---
      const buildQueryOptions = (signal: AbortSignal, includePartial: boolean) => {
        const opts: Record<string, any> = {
          maxTurns: 100,
          model,
          pathToClaudeCodeExecutable: claudeExecutable,
          includePartialMessages: includePartial,
          disallowedTools: [...BLOCKED_BUILTIN_TOOLS],
          allowedTools,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          persistSession: true, // Enable for session reuse
          settingSources: ['user'],
          mcpServers,
          abortSignal: signal,
          env: { CLAUDE_AGENT_SDK_CLIENT_APP: "claude-max-proxy/1.1.0" },
        }

        // Native system prompt
        if (systemPrompt) opts.systemPrompt = systemPrompt

        // Extended thinking
        if (thinkingConfig) opts.thinking = thinkingConfig

        // Effort level pass-through
        if (body.effort) opts.effort = body.effort

        // Fallback model
        if (body.fallback_model) opts.fallbackModel = normalizeModel(body.fallback_model)

        // Budget cap
        if (body.max_budget_usd) opts.maxBudgetUsd = body.max_budget_usd

        // Working directory
        if (body.cwd) opts.cwd = body.cwd

        // Session reuse
        if (resumeSessionId) opts.resume = resumeSessionId

        return opts
      }

      // Queue capacity check
      if (requestQueue.isFull) {
        if (resumeSessionId) sessionPool.release(resumeSessionId)
        logger.warn("queue.full", { requestId })
        metrics.recordRequest({ model, status: "queue_full", durationMs: Date.now() - startTime })
        return c.json(
          { type: "error", error: { type: "overloaded_error", message: "Server is at capacity, please retry later" } },
          503,
          { "Retry-After": "5", "X-Request-ID": requestId }
        )
      }

      // Track real usage from SDK result messages
      let realUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null = null
      let totalCostUsd = 0
      let capturedSessionId: string | null = null

      if (!stream) {
        // ==================== NON-STREAMING ====================
        let fullContent = ""

        await requestQueue.enqueue(async (signal) => {
          logger.info("query.started", {
            requestId, model, stream: false,
            sessionReuse: !!resumeSessionId,
          })

          let lastError: unknown
          for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
            if (attempt > 0) {
              logger.info("query.retry", { requestId, attempt })
              await sleep(jitter(1000))
            }
            try {
              const response = query({ prompt, options: buildQueryOptions(signal, false) })

              for await (const message of response) {
                if (message.type === "assistant") {
                  for (const block of message.message.content) {
                    if (block.type === "text") fullContent += block.text
                  }
                }
                // Capture real usage from result message
                if (message.type === "result") {
                  const r = message as any
                  if (r.usage) {
                    realUsage = {
                      input_tokens: r.usage.input_tokens ?? 0,
                      output_tokens: r.usage.output_tokens ?? 0,
                      cache_read_input_tokens: r.usage.cache_read_input_tokens ?? 0,
                      cache_creation_input_tokens: r.usage.cache_creation_input_tokens ?? 0,
                    }
                  }
                  totalCostUsd = r.total_cost_usd ?? 0
                  capturedSessionId = r.session_id ?? null
                }
                // Track rate limit events
                if (message.type === "rate_limit_event") {
                  rateLimiter.update((message as any).rate_limit_info)
                }
              }
              return
            } catch (err) {
              if (err instanceof Error && err.name === "AbortError") throw err
              if (signal.aborted) throw new TimeoutError(finalConfig.requestTimeoutMs)
              lastError = err
              // Invalidate session on error — it may be corrupted
              if (resumeSessionId) sessionPool.invalidate(resumeSessionId)
              logger.error("query.error", { requestId, attempt, error: err instanceof Error ? err.message : String(err) })
            }
          }
          throw lastError
        })

        // Register/release session for reuse
        if (capturedSessionId) {
          if (resumeSessionId) {
            sessionPool.release(resumeSessionId)
          } else {
            sessionPool.register(model, capturedSessionId)
          }
        }

        if (!fullContent) {
          fullContent = "I can help with that. Could you provide more details about what you'd like me to do?"
        }

        const usage = realUsage || {
          input_tokens: Math.ceil(prompt.length / 4),
          output_tokens: Math.ceil(fullContent.length / 4),
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }

        metrics.recordRequest({ model, status: "success", durationMs: Date.now() - startTime })
        metrics.addTokenEstimates(usage.input_tokens, usage.output_tokens)

        logger.info("request.completed", {
          requestId,
          durationMs: Date.now() - startTime,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          costUsd: totalCostUsd,
          sessionReuse: !!resumeSessionId,
        })

        return c.json(
          {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: fullContent }],
            model: body.model,
            stop_reason: "end_turn",
            usage,
          },
          200,
          {
            "X-Request-ID": requestId,
            ...(realUsage ? {} : { "X-Token-Usage-Estimated": "true" }),
            ...(totalCostUsd ? { "X-Total-Cost-USD": String(totalCostUsd) } : {}),
          }
        )
      }

      // ==================== STREAMING ====================
      const encoder = new TextEncoder()
      let outputCharsCount = 0

      const readable = new ReadableStream({
        async start(controller) {
          const enqueue = (data: string) => {
            try { controller.enqueue(encoder.encode(data)) } catch {}
          }

          try {
            await requestQueue.enqueue(async (signal) => {
              logger.info("query.started", {
                requestId, model, stream: true,
                sessionReuse: !!resumeSessionId,
              })

              let lastError: unknown
              for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
                if (attempt > 0) {
                  if (outputCharsCount > 0) throw lastError
                  logger.info("query.retry", { requestId, attempt })
                  await sleep(jitter(1000))
                }
                try {
                  const response = query({ prompt, options: buildQueryOptions(signal, true) })
                  const heartbeat = setInterval(() => enqueue(`: ping\n\n`), finalConfig.heartbeatMs)

                  try {
                    for await (const message of response) {
                      if (message.type === "stream_event") {
                        const event = message.event
                        const eventType = event.type

                        if (eventType === "message_delta") {
                          const patched = {
                            ...event,
                            delta: { ...((event as any).delta || {}), stop_reason: "end_turn" },
                            usage: (event as any).usage || { output_tokens: 0 },
                          }
                          enqueue(`event: ${eventType}\ndata: ${JSON.stringify(patched)}\n\n`)
                          continue
                        }

                        if (eventType === "content_block_delta" && (event as any).delta?.text) {
                          outputCharsCount += (event as any).delta.text.length
                        }

                        enqueue(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                      }

                      // Capture real usage from result
                      if (message.type === "result") {
                        const r = message as any
                        if (r.usage) {
                          realUsage = {
                            input_tokens: r.usage.input_tokens ?? 0,
                            output_tokens: r.usage.output_tokens ?? 0,
                            cache_read_input_tokens: r.usage.cache_read_input_tokens ?? 0,
                            cache_creation_input_tokens: r.usage.cache_creation_input_tokens ?? 0,
                          }
                        }
                        totalCostUsd = r.total_cost_usd ?? 0
                        capturedSessionId = r.session_id ?? null
                      }

                      // Track rate limits
                      if (message.type === "rate_limit_event") {
                        rateLimiter.update((message as any).rate_limit_info)
                      }
                    }
                  } finally {
                    clearInterval(heartbeat)
                  }
                  return
                } catch (err) {
                  if (err instanceof Error && err.name === "AbortError") throw err
                  if (signal.aborted) throw new TimeoutError(finalConfig.requestTimeoutMs)
                  lastError = err
                  if (resumeSessionId) sessionPool.invalidate(resumeSessionId)
                  logger.error("query.error", { requestId, attempt, error: err instanceof Error ? err.message : String(err) })
                }
              }
              throw lastError
            })

            // Register/release session
            if (capturedSessionId) {
              if (resumeSessionId) sessionPool.release(resumeSessionId)
              else sessionPool.register(model, capturedSessionId)
            }

            const usage = realUsage || { input_tokens: 0, output_tokens: Math.ceil(outputCharsCount / 4) }
            metrics.recordRequest({ model, status: "success", durationMs: Date.now() - startTime })
            metrics.addTokenEstimates(usage.input_tokens, usage.output_tokens)

            logger.info("request.completed", {
              requestId,
              durationMs: Date.now() - startTime,
              outputChars: outputCharsCount,
              costUsd: totalCostUsd,
              sessionReuse: !!resumeSessionId,
            })

            controller.close()
          } catch (error) {
            if (resumeSessionId) sessionPool.release(resumeSessionId)
            const isTimeout = error instanceof TimeoutError
            metrics.recordRequest({ model, status: isTimeout ? "timeout" : "error", durationMs: Date.now() - startTime })
            logger.error("request.failed", { requestId, error: error instanceof Error ? error.message : String(error) })
            enqueue(`event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: isTimeout ? "timeout_error" : "api_error", message: error instanceof Error ? error.message : "Unknown error" }
            })}\n\n`)
            controller.close()
          }
        }
      })

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Request-ID": requestId,
        }
      })
    } catch (error) {
      if (error instanceof QueueFullError) {
        logger.warn("queue.full", { requestId })
        metrics.recordRequest({ model: "unknown", status: "queue_full", durationMs: Date.now() - startTime })
        return c.json(
          { type: "error", error: { type: "overloaded_error", message: "Server is at capacity, please retry later" } },
          503,
          { "Retry-After": "5", "X-Request-ID": requestId }
        )
      }
      logger.error("request.error", { requestId, error: error instanceof Error ? error.message : String(error) })
      return c.json(
        { type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : "Unknown error" } },
        500,
        { "X-Request-ID": requestId }
      )
    }
  }

  app.post("/v1/messages", handleMessages)
  app.post("/messages", handleMessages)

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig } = createProxyServer(config)

  const server = Bun.serve({
    port: finalConfig.port,
    hostname: finalConfig.host,
    fetch: app.fetch
  })

  logger.info("server.started", {
    port: finalConfig.port,
    host: finalConfig.host,
    maxConcurrent: finalConfig.maxConcurrent,
    maxQueue: finalConfig.maxQueue,
    requestTimeoutMs: finalConfig.requestTimeoutMs,
    sessionTtlMs: finalConfig.sessionTtlMs,
  })

  console.log(`Claude Max Proxy v1.1.0 running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`  Health:  http://${finalConfig.host}:${finalConfig.port}/health`)
  console.log(`  Metrics: http://${finalConfig.host}:${finalConfig.port}/metrics`)
  console.log(`\nFeatures: session-pool, real-tokens, model-routing, rate-limit-detection, multimodal, cache-control`)
  console.log(`\nTo use with OpenCode:`)
  console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} opencode`)

  return server
}
