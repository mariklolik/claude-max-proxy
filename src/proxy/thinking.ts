interface AnthropicThinkingConfig {
  type: "enabled" | "disabled"
  budget_tokens?: number
}

interface SdkThinkingConfig {
  type: "enabled" | "disabled" | "adaptive"
  budgetTokens?: number
}

export function mapThinkingConfig(
  thinking: AnthropicThinkingConfig | undefined,
  model: string
): SdkThinkingConfig | undefined {
  if (!thinking) return undefined
  if (thinking.type === "disabled") return { type: "disabled" }

  if (model.includes("opus") && !thinking.budget_tokens) {
    return { type: "adaptive" }
  }

  return { type: "enabled", budgetTokens: thinking.budget_tokens || 10000 }
}
