const startTime = Date.now()

interface RequestMetric {
  model: string
  status: "success" | "error" | "timeout" | "queue_full"
  durationMs: number
}

class ReservoirSampler {
  private samples: number[] = []
  private count = 0
  private readonly maxSize: number

  constructor(maxSize = 1000) { this.maxSize = maxSize }

  add(value: number): void {
    this.count++
    if (this.samples.length < this.maxSize) {
      this.samples.push(value)
    } else {
      const idx = Math.floor(Math.random() * this.count)
      if (idx < this.maxSize) this.samples[idx] = value
    }
  }

  percentile(p: number): number {
    if (this.samples.length === 0) return 0
    const sorted = [...this.samples].sort((a, b) => a - b)
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)]!
  }
}

class Metrics {
  private requestsTotal = new Map<string, number>()
  private errorsTotal = new Map<string, number>()
  private _requestsActive = 0
  private _requestsQueued = 0
  private durationSampler = new ReservoirSampler()
  private _inputTokensEstimated = 0
  private _outputTokensEstimated = 0

  get uptimeSeconds(): number { return Math.floor((Date.now() - startTime) / 1000) }
  get requestsActive(): number { return this._requestsActive }
  get requestsQueued(): number { return this._requestsQueued }

  setActiveRequests(count: number): void { this._requestsActive = count }
  setQueuedRequests(count: number): void { this._requestsQueued = count }

  recordRequest(metric: RequestMetric): void {
    const key = `${metric.model}:${metric.status}`
    this.requestsTotal.set(key, (this.requestsTotal.get(key) || 0) + 1)
    this.durationSampler.add(metric.durationMs)
    if (metric.status !== "success") {
      this.errorsTotal.set(metric.status, (this.errorsTotal.get(metric.status) || 0) + 1)
    }
  }

  addTokenEstimates(input: number, output: number): void {
    this._inputTokensEstimated += input
    this._outputTokensEstimated += output
  }

  getHealth(): object {
    return {
      status: "ok",
      uptime: this.uptimeSeconds,
      activeRequests: this._requestsActive,
      queuedRequests: this._requestsQueued,
    }
  }

  getMetrics(): object {
    const errorsByType: Record<string, number> = {}
    for (const [type, count] of this.errorsTotal) errorsByType[type] = count

    return {
      uptime_seconds: this.uptimeSeconds,
      requests_total: Object.fromEntries(this.requestsTotal),
      requests_active: this._requestsActive,
      requests_queued: this._requestsQueued,
      request_duration_ms: {
        p50: this.durationSampler.percentile(50),
        p95: this.durationSampler.percentile(95),
        p99: this.durationSampler.percentile(99),
      },
      errors_total: errorsByType,
      tokens_estimated: {
        input: this._inputTokensEstimated,
        output: this._outputTokensEstimated,
      },
    }
  }
}

export const metrics = new Metrics()
