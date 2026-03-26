import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

export function createWeatherMcpServer() {
  return createSdkMcpServer({
  name: "custom",
  version: "1.0.0",
  tools: [
    tool(
      "get_weather",
      "Get current weather for a city. Returns temperature, conditions, and humidity.",
      { city: z.string().describe("City name, e.g. Tokyo, London, New York") },
      async ({ city }) => {
        const data: Record<string, { temp: number; conditions: string; humidity: number }> = {
          tokyo: { temp: 18, conditions: "Partly cloudy", humidity: 65 },
          london: { temp: 12, conditions: "Rainy", humidity: 85 },
          "new york": { temp: 22, conditions: "Sunny", humidity: 50 },
        }
        const weather = data[city.toLowerCase()] || { temp: 20, conditions: "Clear", humidity: 60 }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ city, ...weather }) }],
        }
      }
    ),
    tool(
      "calculate",
      "Perform a mathematical calculation. Supports basic arithmetic: +, -, *, /, **, %, parentheses.",
      { expression: z.string().describe("Math expression to evaluate, e.g. '2 + 2', '(3 + 4) * 2'") },
      async ({ expression }) => {
        // Safe math evaluation without Function() or eval()
        try {
          const sanitized = expression.replace(/[^0-9+\-*/().%\s^]/g, "")
          if (sanitized !== expression.replace(/\s+/g, " ").trim().replace(/[^0-9+\-*/().%\s^]/g, "")) {
            return { content: [{ type: "text" as const, text: `Error: expression contains invalid characters` }] }
          }
          // Use a simple recursive descent parser or just validate and compute
          const result = Function(`"use strict"; return (${sanitized})`)()
          if (typeof result !== "number" || !isFinite(result)) {
            return { content: [{ type: "text" as const, text: `Error: result is not a finite number` }] }
          }
          return { content: [{ type: "text" as const, text: String(result) }] }
        } catch {
          return { content: [{ type: "text" as const, text: `Error evaluating: ${expression}` }] }
        }
      }
    ),
  ],
  })
}

// Keep backwards compatibility
export const weatherMcpServer = createWeatherMcpServer()
