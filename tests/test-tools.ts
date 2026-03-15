#!/usr/bin/env bun

/**
 * Dynamic tool registration test for claude-max-proxy.
 *
 * Tests:
 * 1. Sending a request with custom tool definitions
 * 2. Verifying the proxy accepts and processes tool definitions
 * 3. Testing that tools are forwarded in the response
 *
 * Usage:
 *   bun run tests/test-tools.ts [--url=http://127.0.0.1:3456]
 */

const BASE_URL = process.argv.find((a) => a.startsWith("--url="))?.split("=")[1] || "http://127.0.0.1:3456"

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`)
    process.exitCode = 1
  } else {
    console.log(`  PASS: ${message}`)
  }
}

async function testDynamicToolRegistration() {
  console.log("\n--- Test: Dynamic Tool Registration ---")

  const tools = [
    {
      name: "get_current_time",
      description: "Get the current time in a specific timezone",
      input_schema: {
        type: "object" as const,
        properties: {
          timezone: { type: "string", description: "IANA timezone like America/New_York" },
        },
        required: ["timezone"],
      },
    },
    {
      name: "search_database",
      description: "Search the database for records matching a query",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results to return" },
        },
        required: ["query"],
      },
    },
  ]

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonnet",
      stream: true,
      messages: [
        {
          role: "user",
          content: "What time is it in New York? Use the get_current_time tool.",
        },
      ],
      tools,
    }),
    signal: AbortSignal.timeout(300_000),
  })

  assert(res.ok, `Response should be 200, got ${res.status}`)
  assert(
    res.headers.get("content-type")?.includes("text/event-stream") === true,
    "Should return SSE stream"
  )

  // Consume the stream
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let eventCount = 0
  let hasToolUse = false
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split("\n\n")
    buffer = parts.pop()!

    for (const part of parts) {
      if (part.trim() === ": ping") continue

      let data = ""
      for (const line of part.split("\n")) {
        if (line.startsWith("data: ")) data = line.slice(6)
      }

      if (data) {
        eventCount++
        try {
          const event = JSON.parse(data)
          // Check if Claude tried to use the tool
          if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            hasToolUse = true
            console.log(`  Tool use detected: ${event.content_block.name}`)
          }
        } catch {}
      }
    }
  }

  assert(eventCount > 0, `Should receive events, got ${eventCount}`)
  console.log(`  Total events: ${eventCount}`)
  console.log(`  Tool use in response: ${hasToolUse}`)
}

async function testToolsWithNonStreaming() {
  console.log("\n--- Test: Dynamic Tools (Non-Streaming) ---")

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonnet",
      stream: false,
      messages: [{ role: "user", content: "Hello, just respond with a greeting." }],
      tools: [
        {
          name: "greet",
          description: "Generate a greeting",
          input_schema: { type: "object", properties: { name: { type: "string" } } },
        },
      ],
    }),
    signal: AbortSignal.timeout(300_000),
  })

  assert(res.ok, `Response should be 200, got ${res.status}`)

  const data = await res.json() as Record<string, any>
  assert(data.type === "message", `Response type should be "message", got "${data.type}"`)
  assert(data.content?.length > 0, "Should have content")
  assert(data.usage !== undefined, "Should have usage")
  assert(
    res.headers.get("x-request-id") !== null,
    "Should have X-Request-ID header"
  )

  console.log(`  Response: ${data.content?.[0]?.text?.slice(0, 80)}...`)
  console.log(`  Usage: ${JSON.stringify(data.usage)}`)
}

async function testNoTools() {
  console.log("\n--- Test: Request Without Tools (baseline) ---")

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonnet",
      stream: false,
      messages: [{ role: "user", content: "Say hi in one word." }],
    }),
    signal: AbortSignal.timeout(300_000),
  })

  assert(res.ok, `Response should be 200, got ${res.status}`)

  const data = await res.json() as Record<string, any>
  assert(data.type === "message", "Response should be a message")
  assert(data.content?.[0]?.text?.length > 0, "Should have text content")
  console.log(`  Response: ${data.content?.[0]?.text}`)
}

async function main() {
  console.log(`\n=== Dynamic Tool Registration Test ===`)
  console.log(`URL: ${BASE_URL}\n`)

  // Check proxy is running
  try {
    await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) })
  } catch {
    console.error(`ERROR: Cannot reach proxy at ${BASE_URL}. Is it running?`)
    process.exit(1)
  }

  await testNoTools()
  await testToolsWithNonStreaming()
  await testDynamicToolRegistration()

  console.log(`\nDone.`)
}

main()
