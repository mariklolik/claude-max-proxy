import { Hono } from "hono"
import { cors } from "hono/cors"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "hono"
import type { ProxyConfig } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { logger, generateRequestId } from "../logger"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { spawn } from "child_process"
import { createDynamicToolServer } from "./tools"
import { mapThinkingConfig } from "./thinking"
import { RequestQueue, QueueFullError, TimeoutError } from "./queue"
import { metrics } from "./metrics"
import { normalizeModel, autoRouteModel } from "./model-router"
import { rateLimiter } from "./rate-limiter"

/**
 * Resolve the Claude Code executable path.
 * Priority: CLAUDE_CODE_EXECUTABLE env > SDK-bundled cli.js > which claude
 */
function resolveClaudeExecutable(): string {
  if (process.env.CLAUDE_CODE_EXECUTABLE && existsSync(process.env.CLAUDE_CODE_EXECUTABLE)) {
    return process.env.CLAUDE_CODE_EXECUTABLE
  }
  try {
    const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
    const sdkCliJs = join(dirname(sdkPath), "cli.js")
    if (existsSync(sdkCliJs)) return sdkCliJs
  } catch {}
  try {
    const { execSync } = require("child_process")
    const claudePath = execSync("which claude", { encoding: "utf-8" }).trim()
    if (claudePath && existsSync(claudePath)) return claudePath
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

// --- Prompt and message helpers ---

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

function buildPromptFromMessages(
  messages: Array<{ role: string; content: string | Array<any> }> | undefined,
  systemPrompt?: string,
): string {
  if (!messages) return ""
  const parts: string[] = []
  if (systemPrompt) parts.push(`System: ${systemPrompt}`)
  for (const m of messages) {
    const role = m.role === "assistant" ? "Assistant" : "Human"
    let content: string
    if (typeof m.content === "string") {
      content = m.content
    } else if (Array.isArray(m.content)) {
      const blocks: string[] = []
      for (const block of m.content) {
        if (block.type === "text" && block.text) blocks.push(block.text)
        else if (block.type === "image") {
          const source = block.source
          if (source?.type === "base64") blocks.push(`[Image: ${source.media_type}, ${Math.round((source.data?.length || 0) * 3 / 4 / 1024)}KB]`)
          else if (source?.type === "url") blocks.push(`[Image: ${source.url}]`)
        } else if (block.type === "tool_use") {
          blocks.push(`[Tool call: ${block.name}(${JSON.stringify(block.input)})]`)
        } else if (block.type === "tool_result") {
          const rc = typeof block.content === "string" ? block.content
            : Array.isArray(block.content) ? block.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : ""
          blocks.push(`[Tool result: ${rc}]`)
        }
      }
      content = blocks.join("")
    } else {
      content = String(m.content)
    }
    parts.push(`${role}: ${content}`)
  }
  return parts.join("\n\n")
}

function totalMessageLength(messages: Array<{ content: string | Array<any> }> | undefined): number {
  if (!messages) return 0
  let len = 0
  for (const m of messages) {
    if (typeof m.content === "string") len += m.content.length
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text") len += (block.text || "").length
      }
    }
  }
  return len
}

function hasImageContent(messages: Array<{ content: string | Array<any> }> | undefined): boolean {
  if (!messages) return false
  for (const m of messages) {
    if (Array.isArray(m.content) && m.content.some((b: any) => b.type === "image")) return true
  }
  return false
}

// --- Fast path: direct CLI spawn for non-streaming ---
// Bypasses the SDK's stream-json transport for ~2s less overhead.

function directCliQuery(
  prompt: string,
  model: string,
  opts: {
    systemPrompt?: string
    thinkingConfig?: { type: string; budgetTokens?: number }
    effort?: string
    maxTurns?: number
    cwd?: string
    signal?: AbortSignal
    timeoutMs?: number
  }
): Promise<any> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      claudeExecutable,
      "-p", prompt,
      "--model", model,
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
      "--allow-dangerously-skip-permissions",
    ]

    if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns))
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt)
    if (opts.effort) args.push("--effort", opts.effort)
    if (opts.cwd) args.push("--cwd", opts.cwd)

    if (opts.thinkingConfig) {
      if (opts.thinkingConfig.type === "disabled") {
        args.push("--thinking", "disabled")
      } else if (opts.thinkingConfig.type === "adaptive") {
        args.push("--thinking", "adaptive")
      } else if (opts.thinkingConfig.type === "enabled" && opts.thinkingConfig.budgetTokens) {
        args.push("--max-thinking-tokens", String(opts.thinkingConfig.budgetTokens))
      }
    }

    // Use spawn with minimal stdio (no stderr pipe) for best performance.
    // Piping stderr adds ~4s overhead due to Node's event loop contention.
    const child = spawn("node", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
      cwd: opts.cwd || undefined,
    })

    let stdout = ""
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`Timeout after ${opts.timeoutMs || 300000}ms`))
    }, opts.timeoutMs || 300000)

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        child.kill("SIGTERM")
        reject(new Error("AbortError"))
      }, { once: true })
    }

    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`CLI exited with code ${code}`))
      }
      try {
        const lines = stdout.trim().split("\n")
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim()
          if (line.startsWith("{")) {
            const parsed = JSON.parse(line)
            if (parsed.type === "result") return resolve(parsed)
          }
        }
        resolve(JSON.parse(stdout.trim()))
      } catch {
        resolve({ type: "result", subtype: "success", result: stdout.trim(), is_error: false })
      }
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const requestQueue = new RequestQueue({
    maxConcurrent: finalConfig.maxConcurrent,
    maxQueue: finalConfig.maxQueue,
    requestTimeoutMs: finalConfig.requestTimeoutMs,
  })

  const app = new Hono()
  app.use("*", cors())

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "claude-max-proxy",
      version: "1.2.0",
      format: "anthropic",
      endpoints: ["/v1/messages", "/messages", "/health", "/metrics"],
      features: [
        "real-token-usage", "native-system-prompt", "model-routing",
        "rate-limit-detection", "extended-thinking", "effort-levels",
        "fallback-model", "budget-caps", "dynamic-tools",
      ],
    })
  })

  app.get("/health", (c) => {
    metrics.setActiveRequests(requestQueue.active)
    metrics.setQueuedRequests(requestQueue.queued)
    return c.json({
      ...metrics.getHealth(),
      rateLimit: rateLimiter.getInfo(),
    })
  })

  app.get("/metrics", (c) => {
    metrics.setActiveRequests(requestQueue.active)
    metrics.setQueuedRequests(requestQueue.queued)
    return c.json({
      ...metrics.getMetrics() as object,
      rate_limit: rateLimiter.getInfo(),
    })
  })

  const handleMessages = async (c: Context) => {
    const requestId = generateRequestId()
    const startTime = Date.now()

    try {
      const body = await c.req.json()
      const stream = body.stream ?? true

      // --- Model normalization + routing ---
      const normalizedModel = normalizeModel(body.model || "sonnet")
      const model = autoRouteModel(normalizedModel, {
        hasThinking: !!body.thinking && body.thinking.type !== "disabled",
        toolCount: body.tools?.length || 0,
        messageLength: totalMessageLength(body.messages),
        messageCount: body.messages?.length || 0,
        hasImages: hasImageContent(body.messages),
      })

      logger.info("request.received", { requestId, model, stream, messageCount: body.messages?.length })

      // --- Rate limit check ---
      const throttle = rateLimiter.shouldThrottle()
      if (throttle === "reject") {
        const info = rateLimiter.getInfo()
        return c.json(
          { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
          429,
          { "X-Request-ID": requestId, "Retry-After": info.resetsAt ? String(Math.ceil(info.resetsAt - Date.now() / 1000)) : "60" }
        )
      }
      if (typeof throttle === "number") {
        logger.info("ratelimit.backoff", { requestId, delayMs: throttle })
        await sleep(throttle)
      }

      const systemPrompt = extractSystemPrompt(body.system)
      const prompt = buildPromptFromMessages(body.messages, !stream ? systemPrompt : undefined)
      const wantsThinking = !!body.thinking && body.thinking.type !== "disabled"
      const thinkingConfig = mapThinkingConfig(body.thinking, model)
      const hasDynamicTools = body.tools && body.tools.length > 0

      // ==================== NON-STREAMING: FAST PATH ====================
      // Direct CLI spawn — bypasses SDK stream-json transport for ~2s less overhead.
      // Falls back to SDK for streaming or when dynamic tools are needed.
      if (!stream && !hasDynamicTools) {
        if (requestQueue.isFull) {
          return c.json(
            { type: "error", error: { type: "overloaded_error", message: "Server is at capacity" } },
            503,
            { "Retry-After": "5", "X-Request-ID": requestId }
          )
        }

        let result: any
        await requestQueue.enqueue(async (signal) => {
          logger.info("query.started", { requestId, model, stream: false, path: "direct" })

          let lastError: unknown
          for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
            if (attempt > 0) {
              logger.info("query.retry", { requestId, attempt })
              await sleep(jitter(1000))
            }
            try {
              result = await directCliQuery(prompt, model, {
                systemPrompt: undefined, // Already baked into prompt
                thinkingConfig,
                effort: body.effort,
                maxTurns: 1,
                cwd: body.cwd,
                signal,
                timeoutMs: finalConfig.requestTimeoutMs,
              })
              return
            } catch (err) {
              if (signal.aborted) throw new TimeoutError(finalConfig.requestTimeoutMs)
              lastError = err
              logger.error("query.error", { requestId, attempt, error: err instanceof Error ? err.message : String(err) })
            }
          }
          throw lastError
        })

        const text = result?.result || ""
        const usage = result?.usage ? {
          input_tokens: result.usage.input_tokens ?? 0,
          output_tokens: result.usage.output_tokens ?? 0,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? 0,
        } : {
          input_tokens: Math.ceil(prompt.length / 4),
          output_tokens: Math.ceil(text.length / 4),
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }
        const totalCostUsd = result?.total_cost_usd ?? 0

        metrics.recordRequest({ model, status: "success", durationMs: Date.now() - startTime })
        metrics.addTokenEstimates(usage.input_tokens, usage.output_tokens)

        logger.info("request.completed", {
          requestId, durationMs: Date.now() - startTime,
          inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
          costUsd: totalCostUsd,
        })

        const content: any[] = [{ type: "text", text }]

        return c.json({
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          content,
          model,
          stop_reason: result?.stop_reason || "end_turn",
          usage,
        }, 200, {
          "X-Request-ID": requestId,
          ...(result?.usage ? {} : { "X-Token-Usage-Estimated": "true" }),
          ...(totalCostUsd ? { "X-Total-Cost-USD": String(totalCostUsd) } : {}),
        })
      }

      // ==================== STREAMING (or tools): SDK PATH ====================
      const dynamicTools = hasDynamicTools ? createDynamicToolServer(body.tools) : null
      const mcpServers: Record<string, any> = {}
      const allowedTools: string[] = []
      if (dynamicTools) {
        mcpServers[dynamicTools.mcpName] = dynamicTools.server
        allowedTools.push(...dynamicTools.toolNames)
      }

      const buildQueryOptions = (abortController: AbortController, includePartial: boolean) => {
        const opts: Record<string, any> = {
          model,
          pathToClaudeCodeExecutable: claudeExecutable,
          executable: "node",
          abortController,
          tools: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          persistSession: false,
          maxTurns: hasDynamicTools ? 10 : 1,
          includePartialMessages: includePartial,
          env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "claude-max-proxy/1.2.0" },
        }
        if (Object.keys(mcpServers).length > 0) {
          opts.mcpServers = mcpServers
          opts.allowedTools = allowedTools
        }
        if (systemPrompt) opts.systemPrompt = systemPrompt
        if (thinkingConfig) opts.thinking = thinkingConfig
        if (body.effort) opts.effort = body.effort
        if (body.fallback_model) opts.fallbackModel = normalizeModel(body.fallback_model)
        if (body.max_budget_usd) opts.maxBudgetUsd = body.max_budget_usd
        if (body.cwd) opts.cwd = body.cwd
        return opts
      }

      if (requestQueue.isFull) {
        return c.json(
          { type: "error", error: { type: "overloaded_error", message: "Server is at capacity" } },
          503,
          { "Retry-After": "5", "X-Request-ID": requestId }
        )
      }

      let realUsage: any = null
      let totalCostUsd = 0
      const encoder = new TextEncoder()
      let outputCharsCount = 0
      const thinkingBlockIndices = new Set<number>()

      const readable = new ReadableStream({
        async start(controller) {
          const enqueue = (data: string) => {
            try { controller.enqueue(encoder.encode(data)) } catch {}
          }

          try {
            await requestQueue.enqueue(async (signal) => {
              logger.info("query.started", { requestId, model, stream: true, path: "sdk" })

              const abortController = new AbortController()
              signal.addEventListener("abort", () => abortController.abort(signal.reason), { once: true })

              let lastError: unknown
              for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
                if (attempt > 0) {
                  if (outputCharsCount > 0) throw lastError
                  logger.info("query.retry", { requestId, attempt })
                  await sleep(jitter(1000))
                }
                try {
                  const response = query({ prompt, options: buildQueryOptions(abortController, true) })
                  const heartbeat = setInterval(() => enqueue(`: ping\n\n`), finalConfig.heartbeatMs)

                  try {
                    for await (const message of response) {
                      if (message.type === "stream_event") {
                        const event = message.event
                        const eventType = event.type

                        // Filter thinking blocks when not requested
                        if (!wantsThinking) {
                          if (eventType === "content_block_start" && (event as any).content_block?.type === "thinking") {
                            thinkingBlockIndices.add((event as any).index)
                            continue
                          }
                          if (eventType === "content_block_delta") {
                            const dt = (event as any).delta?.type
                            if (dt === "thinking_delta" || dt === "signature_delta") continue
                            if (thinkingBlockIndices.has((event as any).index)) continue
                          }
                          if (eventType === "content_block_stop" && thinkingBlockIndices.has((event as any).index)) continue
                        }

                        // Patch message_delta
                        if (eventType === "message_delta") {
                          const patched = {
                            ...event,
                            delta: { ...((event as any).delta || {}), stop_reason: (event as any).delta?.stop_reason || "end_turn" },
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
                      }

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
                  logger.error("query.error", { requestId, attempt, error: err instanceof Error ? err.message : String(err) })
                }
              }
              throw lastError
            })

            const usage = realUsage || { input_tokens: 0, output_tokens: Math.ceil(outputCharsCount / 4) }
            metrics.recordRequest({ model, status: "success", durationMs: Date.now() - startTime })
            metrics.addTokenEstimates(usage.input_tokens, usage.output_tokens)
            logger.info("request.completed", { requestId, durationMs: Date.now() - startTime, outputChars: outputCharsCount, costUsd: totalCostUsd })
            controller.close()
          } catch (error) {
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
        metrics.recordRequest({ model: "unknown", status: "queue_full", durationMs: Date.now() - startTime })
        return c.json(
          { type: "error", error: { type: "overloaded_error", message: "Server is at capacity" } },
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
    fetch: app.fetch,
  })

  logger.info("server.started", {
    port: finalConfig.port,
    host: finalConfig.host,
    maxConcurrent: finalConfig.maxConcurrent,
    maxQueue: finalConfig.maxQueue,
    requestTimeoutMs: finalConfig.requestTimeoutMs,
    executable: claudeExecutable,
  })

  console.log(`Claude Max Proxy v1.2.0 running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`  Health:  http://${finalConfig.host}:${finalConfig.port}/health`)
  console.log(`  Metrics: http://${finalConfig.host}:${finalConfig.port}/metrics`)
  console.log(`  CLI:     ${claudeExecutable}`)
  console.log(`\nNon-streaming: direct CLI spawn (fast path)`)
  console.log(`Streaming:     SDK query() with SSE`)
  console.log(`\nUsage: ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} <client>`)

  return server
}
