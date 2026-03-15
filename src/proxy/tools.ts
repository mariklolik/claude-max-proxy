import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

interface AnthropicToolDef {
  name: string
  description?: string
  input_schema?: {
    type: "object"
    properties?: Record<string, unknown>
    required?: string[]
  }
}

const DYNAMIC_MCP_NAME = "dynamic"

export function createDynamicToolServer(toolDefs: AnthropicToolDef[]) {
  if (!toolDefs || toolDefs.length === 0) return null

  const mcpTools = toolDefs.map((def) => {
    const schemaProps: Record<string, z.ZodTypeAny> = {}
    const props = def.input_schema?.properties || {}
    const required = new Set(def.input_schema?.required || [])

    for (const [key] of Object.entries(props)) {
      let field: z.ZodTypeAny = z.any()
      if (!required.has(key)) field = field.optional()
      schemaProps[key] = field
    }

    const schema = Object.keys(schemaProps).length > 0
      ? schemaProps
      : { input: z.any().optional().describe("Tool input") }

    return tool(
      def.name,
      def.description || `Dynamic tool: ${def.name}`,
      schema,
      async (args: Record<string, unknown>) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify({ tool: def.name, input: args, note: "This tool was invoked with the above input. Process the input and respond accordingly." }),
        }],
      })
    )
  })

  const server = createSdkMcpServer({ name: DYNAMIC_MCP_NAME, version: "1.0.0", tools: mcpTools })
  const toolNames = toolDefs.map((t) => `mcp__${DYNAMIC_MCP_NAME}__${t.name}`)

  return { server, toolNames, mcpName: DYNAMIC_MCP_NAME }
}
