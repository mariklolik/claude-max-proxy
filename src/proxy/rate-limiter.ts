import { logger } from "../logger"

interface RateLimitState {
  status: "allowed" | "allowed_warning" | "rejected"
  utilization: number
  resetsAt: number | null
  rateLimitType: string | null
  isUsingOverage: boolean
  lastUpdated: number
}

export class RateLimitTracker {
  private state: RateLimitState = {
    status: "allowed", utilization: 0, resetsAt: null,
    rateLimitType: null, isUsingOverage: false, lastUpdated: 0,
  }
  private readonly warningThreshold: number

  constructor(options: { warningThreshold?: number } = {}) {
    this.warningThreshold = options.warningThreshold ?? 0.8
  }

  update(info: {
    status: string; utilization?: number; resetsAt?: number
    rateLimitType?: string; isUsingOverage?: boolean
  }): void {
    this.state = {
      status: info.status as RateLimitState["status"],
      utilization: info.utilization ?? this.state.utilization,
      resetsAt: info.resetsAt ?? this.state.resetsAt,
      rateLimitType: info.rateLimitType ?? this.state.rateLimitType,
      isUsingOverage: info.isUsingOverage ?? false,
      lastUpdated: Date.now(),
    }
    if (info.status === "rejected") {
      logger.warn("ratelimit.rejected", { type: info.rateLimitType, resetsAt: info.resetsAt, utilization: info.utilization })
    } else if (info.status === "allowed_warning") {
      logger.warn("ratelimit.warning", { utilization: info.utilization, type: info.rateLimitType })
    }
  }

  shouldThrottle(): null | number | "reject" {
    if (Date.now() - this.state.lastUpdated > 300_000) return null
    if (this.state.status === "rejected") {
      if (this.state.resetsAt) {
        const waitMs = this.state.resetsAt * 1000 - Date.now()
        if (waitMs > 0 && waitMs < 300_000) return waitMs
      }
      return "reject"
    }
    if (this.state.utilization >= this.warningThreshold) {
      const severity = (this.state.utilization - this.warningThreshold) / (1 - this.warningThreshold)
      return Math.round(500 + severity * 4500)
    }
    return null
  }

  getInfo() { return { ...this.state } }
}

export const rateLimiter = new RateLimitTracker()
