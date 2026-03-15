#!/usr/bin/env bun

/**
 * Load test for claude-max-proxy.
 *
 * Usage:
 *   bun run tests/load-test.ts --concurrent=5 --requests=20 --type=short
 *
 * Options:
 *   --concurrent=N   Number of concurrent requests (default: 3)
 *   --requests=N     Total number of requests to send (default: 10)
 *   --type=TYPE      Request type: short, medium, long (default: short)
 *   --url=URL        Proxy base URL (default: http://127.0.0.1:3456)
 */

const args = parseArgs()
const BASE_URL: string = args.url || "http://127.0.0.1:3456"
const CONCURRENT: number = args.concurrent || 3
const TOTAL_REQUESTS: number = args.requests || 10
const REQUEST_TYPE: string = args.type || "short"

const PROMPTS: Record<string, string> = {
  short: "Say hello in one word.",
  medium: "Write a short paragraph about the history of computing. Keep it under 200 words.",
  long: "Write a detailed essay about the evolution of programming languages from the 1950s to today. Cover at least 10 languages and their key contributions. Aim for 500+ words.",
}

interface RequestResult {
  index: number
  status: "success" | "error" | "timeout"
  ttftMs: number | null  // Time to first token
  totalMs: number
  tokens: number         // Approximate output tokens (chars / 4)
  error?: string
  interTokenLatencies: number[]
}

async function sendStreamingRequest(index: number): Promise<RequestResult> {
  const prompt = PROMPTS[REQUEST_TYPE] || PROMPTS.short
  const start = performance.now()
  let ttft: number | null = null
  let chars = 0
  const interTokenLatencies: number[] = []
  let lastTokenTime = start

  try {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonnet",
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(600_000), // 10 min timeout
    })

    if (!res.ok) {
      return {
        index,
        status: "error",
        ttftMs: null,
        totalMs: performance.now() - start,
        tokens: 0,
        error: `HTTP ${res.status}`,
        interTokenLatencies: [],
      }
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split("\n")

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        try {
          const event = JSON.parse(line.slice(6))
          if (event.type === "content_block_delta" && event.delta?.text) {
            const now = performance.now()
            if (ttft === null) ttft = now - start
            interTokenLatencies.push(now - lastTokenTime)
            lastTokenTime = now
            chars += event.delta.text.length
          }
        } catch {}
      }
    }

    return {
      index,
      status: "success",
      ttftMs: ttft,
      totalMs: performance.now() - start,
      tokens: Math.ceil(chars / 4),
      interTokenLatencies,
    }
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError"
    return {
      index,
      status: isTimeout ? "timeout" : "error",
      ttftMs: ttft,
      totalMs: performance.now() - start,
      tokens: Math.ceil(chars / 4),
      error: err instanceof Error ? err.message : String(err),
      interTokenLatencies,
    }
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}

async function runLoadTest() {
  console.log(`\n=== Claude Max Proxy Load Test ===`)
  console.log(`URL:        ${BASE_URL}`)
  console.log(`Concurrent: ${CONCURRENT}`)
  console.log(`Requests:   ${TOTAL_REQUESTS}`)
  console.log(`Type:       ${REQUEST_TYPE}`)
  console.log(`Prompt:     "${PROMPTS[REQUEST_TYPE]?.slice(0, 60)}..."`)
  console.log(``)

  // Check proxy is running
  try {
    const health = await fetch(`${BASE_URL}/health`)
    const data = await health.json() as { status: string; uptime: number }
    console.log(`Proxy status: ${data.status} (uptime: ${data.uptime}s)\n`)
  } catch {
    console.error(`ERROR: Cannot reach proxy at ${BASE_URL}. Is it running?`)
    process.exit(1)
  }

  const results: RequestResult[] = []
  let completed = 0
  let nextIndex = 0

  const runNext = async (): Promise<void> => {
    while (nextIndex < TOTAL_REQUESTS) {
      const idx = nextIndex++
      const result = await sendStreamingRequest(idx)
      results.push(result)
      completed++
      const pct = Math.round((completed / TOTAL_REQUESTS) * 100)
      process.stdout.write(`\r  Progress: ${completed}/${TOTAL_REQUESTS} (${pct}%) - #${idx} ${result.status} ${Math.round(result.totalMs)}ms`)
    }
  }

  const startTime = performance.now()
  const workers = Array.from({ length: Math.min(CONCURRENT, TOTAL_REQUESTS) }, () => runNext())
  await Promise.all(workers)
  const totalTime = performance.now() - startTime

  console.log(`\n`)

  // Analyze results
  const successes = results.filter((r) => r.status === "success")
  const errors = results.filter((r) => r.status === "error")
  const timeouts = results.filter((r) => r.status === "timeout")

  const durations = successes.map((r) => r.totalMs)
  const ttfts = successes.map((r) => r.ttftMs!).filter((t) => t !== null)
  const allInterToken = successes.flatMap((r) => r.interTokenLatencies)

  console.log(`=== Results ===`)
  console.log(``)
  console.log(`  Total time:     ${(totalTime / 1000).toFixed(1)}s`)
  console.log(`  Throughput:     ${(successes.length / (totalTime / 1000)).toFixed(2)} req/s`)
  console.log(`  Success:        ${successes.length}/${TOTAL_REQUESTS}`)
  console.log(`  Errors:         ${errors.length}`)
  console.log(`  Timeouts:       ${timeouts.length}`)
  console.log(``)

  if (durations.length > 0) {
    console.log(`  Duration (ms):  p50=${Math.round(percentile(durations, 50))}  p95=${Math.round(percentile(durations, 95))}  p99=${Math.round(percentile(durations, 99))}`)
  }
  if (ttfts.length > 0) {
    console.log(`  TTFT (ms):      p50=${Math.round(percentile(ttfts, 50))}  p95=${Math.round(percentile(ttfts, 95))}  p99=${Math.round(percentile(ttfts, 99))}`)
  }
  if (allInterToken.length > 0) {
    console.log(`  Inter-token:    p50=${Math.round(percentile(allInterToken, 50))}ms  p95=${Math.round(percentile(allInterToken, 95))}ms`)
  }

  if (errors.length > 0) {
    console.log(`\n  Errors:`)
    for (const r of errors) {
      console.log(`    #${r.index}: ${r.error}`)
    }
  }
}

function parseArgs(): Record<string, any> {
  const result: Record<string, any> = {}
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w+)=(.+)$/)
    if (match) {
      const val = match[2]!
      result[match[1]!] = isNaN(Number(val)) ? val : Number(val)
    }
  }
  return result
}

runLoadTest()
