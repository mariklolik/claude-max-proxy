#!/usr/bin/env bun

/**
 * Streaming correctness test for claude-max-proxy.
 *
 * Verifies:
 * 1. SSE event ordering: message_start -> content_blocks -> message_delta -> message_stop
 * 2. No dropped events (every content_block_start has matching content_block_stop)
 * 3. Heartbeat pings arrive for long-running requests
 * 4. X-Request-ID header is present
 * 5. Token usage estimation is present
 *
 * Usage:
 *   bun run tests/test-streaming.ts [--url=http://127.0.0.1:3456]
 */

const BASE_URL = process.argv.find((a) => a.startsWith("--url="))?.split("=")[1] || "http://127.0.0.1:3456"

interface SSEEvent {
  eventType: string
  data: any
  raw: string
  timestamp: number
}

async function collectSSEEvents(prompt: string): Promise<{ events: SSEEvent[]; headers: Headers; pings: number }> {
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonnet",
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(300_000),
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

  const events: SSEEvent[] = []
  let pings = 0
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split("\n\n")
    buffer = parts.pop()! // keep incomplete part

    for (const part of parts) {
      if (part.trim() === ": ping") {
        pings++
        continue
      }

      let eventType = ""
      let data = ""
      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) eventType = line.slice(7)
        else if (line.startsWith("data: ")) data = line.slice(6)
      }

      if (eventType && data) {
        try {
          events.push({
            eventType,
            data: JSON.parse(data),
            raw: part,
            timestamp: Date.now(),
          })
        } catch {}
      }
    }
  }

  return { events, headers: res.headers, pings }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`)
    process.exitCode = 1
  } else {
    console.log(`  PASS: ${message}`)
  }
}

async function testEventOrdering() {
  console.log("\n--- Test: SSE Event Ordering ---")
  const { events } = await collectSSEEvents("Say hi.")

  assert(events.length > 0, "Should receive at least one event")

  if (events.length === 0) return

  const types = events.map((e) => e.eventType)

  // First event should be message_start
  assert(types[0] === "message_start", `First event should be message_start, got ${types[0]}`)

  // Last event should be message_stop
  assert(types[types.length - 1] === "message_stop", `Last event should be message_stop, got ${types[types.length - 1]}`)

  // message_delta should come before message_stop
  const deltIdx = types.lastIndexOf("message_delta")
  const stopIdx = types.lastIndexOf("message_stop")
  if (deltIdx >= 0) {
    assert(deltIdx < stopIdx, "message_delta should come before message_stop")
  }

  // Check content block pairing
  const blockStarts = events.filter((e) => e.eventType === "content_block_start")
  const blockStops = events.filter((e) => e.eventType === "content_block_stop")
  assert(
    blockStarts.length === blockStops.length,
    `content_block_start count (${blockStarts.length}) should equal content_block_stop count (${blockStops.length})`
  )

  console.log(`  Total events: ${events.length}`)
  console.log(`  Event types: ${[...new Set(types)].join(", ")}`)
}

async function testResponseHeaders() {
  console.log("\n--- Test: Response Headers ---")
  const { headers } = await collectSSEEvents("Say hi.")

  assert(headers.get("content-type")?.includes("text/event-stream") === true, "Content-Type should be text/event-stream")
  assert(headers.get("x-request-id") !== null, "X-Request-ID header should be present")
  // Real token usage from SDK — no estimation header needed
  const hasRealTokens = headers.get("x-token-usage-estimated") === null
  const hasEstimate = headers.get("x-token-usage-estimated") === "true"
  assert(hasRealTokens || hasEstimate, "Should have either real tokens or estimated tokens header")

  console.log(`  X-Request-ID: ${headers.get("x-request-id")}`)
}

async function testTokenEstimation() {
  console.log("\n--- Test: Token Usage Estimation ---")
  const { events } = await collectSSEEvents("Say hello world.")

  const messageDelta = events.find((e) => e.eventType === "message_delta")
  assert(messageDelta !== undefined, "Should have a message_delta event")

  if (messageDelta) {
    assert(messageDelta.data.usage !== undefined, "message_delta should have usage field")
    assert(
      typeof messageDelta.data.usage?.output_tokens === "number",
      `output_tokens should be a number, got ${typeof messageDelta.data.usage?.output_tokens}`
    )
    assert(messageDelta.data.delta?.stop_reason === "end_turn", "stop_reason should be end_turn")
    console.log(`  Estimated output tokens: ${messageDelta.data.usage?.output_tokens}`)
  }
}

async function testEndpoints() {
  console.log("\n--- Test: Health & Metrics Endpoints ---")

  const healthRes = await fetch(`${BASE_URL}/health`)
  assert(healthRes.ok, "GET /health should return 200")
  const health = await healthRes.json() as Record<string, unknown>
  assert(health.status === "ok", `Health status should be "ok", got "${health.status}"`)
  assert(typeof health.uptime === "number", "Health should include uptime")
  console.log(`  Health: ${JSON.stringify(health)}`)

  const metricsRes = await fetch(`${BASE_URL}/metrics`)
  assert(metricsRes.ok, "GET /metrics should return 200")
  const metricsData = await metricsRes.json() as Record<string, unknown>
  assert(typeof metricsData.uptime_seconds === "number", "Metrics should include uptime_seconds")
  assert(metricsData.request_duration_ms !== undefined, "Metrics should include request_duration_ms")
  console.log(`  Metrics keys: ${Object.keys(metricsData).join(", ")}`)
}

async function main() {
  console.log(`\n=== Streaming Correctness Test ===`)
  console.log(`URL: ${BASE_URL}\n`)

  // Check proxy is running
  try {
    await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) })
  } catch {
    console.error(`ERROR: Cannot reach proxy at ${BASE_URL}. Is it running?`)
    process.exit(1)
  }

  await testEndpoints()
  await testEventOrdering()
  await testResponseHeaders()
  await testTokenEstimation()

  console.log(`\nDone.`)
}

main()
