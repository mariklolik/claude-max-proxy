type SdkModel = "sonnet" | "opus" | "haiku"

const MODEL_PATTERNS: Array<{ pattern: RegExp; model: SdkModel }> = [
  { pattern: /opus/i, model: "opus" },
  { pattern: /haiku/i, model: "haiku" },
  { pattern: /sonnet/i, model: "sonnet" },
]

const MODEL_ALIASES: Record<string, SdkModel> = {
  "opus": "opus", "sonnet": "sonnet", "haiku": "haiku",
  "claude-opus-4-6": "opus", "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4-5": "sonnet", "claude-haiku-4-5": "haiku",
  "claude-opus-4": "opus", "claude-sonnet-4": "sonnet",
  "claude-opus-4-6-20250514": "opus", "claude-sonnet-4-6-20250514": "sonnet",
  "claude-sonnet-4-5-20250514": "sonnet", "claude-haiku-4-5-20251001": "haiku",
  "claude-opus-4-20250514": "opus", "claude-sonnet-4-20250514": "sonnet",
  "claude-3-5-sonnet-20241022": "sonnet", "claude-3-5-sonnet-latest": "sonnet",
  "claude-3-5-haiku-20241022": "haiku", "claude-3-opus-20240229": "opus",
  "claude-3-sonnet-20240229": "sonnet", "claude-3-haiku-20240307": "haiku",
  "anthropic/claude-opus-4-6": "opus", "anthropic/claude-sonnet-4-6": "sonnet",
  "anthropic/claude-sonnet-4-5": "sonnet", "anthropic/claude-haiku-4-5": "haiku",
  "anthropic/claude-opus-4": "opus", "anthropic/claude-sonnet-4": "sonnet",
  "anthropic/claude-3-5-sonnet": "sonnet", "anthropic/claude-3-5-haiku": "haiku",
  "anthropic/claude-3-opus": "opus",
  "anthropic/claude-opus-4-6:beta": "opus", "anthropic/claude-sonnet-4-6:beta": "sonnet",
}

export function normalizeModel(model: string): SdkModel {
  if (!model) return "sonnet"
  const cleaned = model.trim()
  const aliased = MODEL_ALIASES[cleaned] || MODEL_ALIASES[cleaned.toLowerCase()]
  if (aliased) return aliased
  for (const { pattern, model: sdkModel } of MODEL_PATTERNS) {
    if (pattern.test(cleaned)) return sdkModel
  }
  return "sonnet"
}

interface RoutingContext {
  hasThinking: boolean
  toolCount: number
  messageLength: number
  messageCount: number
  hasImages: boolean
}

export function autoRouteModel(requestedModel: SdkModel, ctx: RoutingContext): SdkModel {
  if (process.env.CLAUDE_PROXY_AUTO_ROUTE !== "1") return requestedModel
  if (ctx.hasThinking) return "opus"
  if (ctx.messageLength < 200 && ctx.toolCount === 0 && ctx.messageCount <= 2 && !ctx.hasImages) return "haiku"
  return requestedModel
}
