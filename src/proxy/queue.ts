export class RequestQueue {
  private queue: Array<{
    fn: (signal: AbortSignal) => Promise<void>
    resolve: (value: void) => void
    reject: (reason: unknown) => void
    abortController: AbortController
    enqueuedAt: number
  }> = []
  private activeCount = 0
  private readonly maxConcurrent: number
  private readonly maxQueue: number
  private readonly requestTimeoutMs: number

  constructor(options: {
    maxConcurrent?: number
    maxQueue?: number
    requestTimeoutMs?: number
  } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? parseInt(process.env.CLAUDE_PROXY_MAX_CONCURRENT || "3", 10)
    this.maxQueue = options.maxQueue ?? parseInt(process.env.CLAUDE_PROXY_MAX_QUEUE || "10", 10)
    this.requestTimeoutMs = options.requestTimeoutMs ?? parseInt(process.env.CLAUDE_PROXY_REQUEST_TIMEOUT_MS || "300000", 10)
  }

  get active(): number { return this.activeCount }
  get queued(): number { return this.queue.length }
  get isFull(): boolean { return this.activeCount >= this.maxConcurrent && this.queue.length >= this.maxQueue }

  async enqueue(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeCount < this.maxConcurrent) return this.execute(fn)
    if (this.queue.length >= this.maxQueue) throw new QueueFullError(this.queue.length)

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, abortController: new AbortController(), enqueuedAt: Date.now() })
    })
  }

  private async execute(fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    this.activeCount++
    const abortController = new AbortController()
    const timeout = setTimeout(() => {
      abortController.abort(new TimeoutError(this.requestTimeoutMs))
    }, this.requestTimeoutMs)

    try {
      await fn(abortController.signal)
    } finally {
      clearTimeout(timeout)
      this.activeCount--
      this.processNext()
    }
  }

  private processNext(): void {
    if (this.queue.length === 0 || this.activeCount >= this.maxConcurrent) return

    const next = this.queue.shift()!
    const waitTime = Date.now() - next.enqueuedAt

    if (waitTime >= this.requestTimeoutMs) {
      next.reject(new TimeoutError(this.requestTimeoutMs))
      this.processNext()
      return
    }

    this.activeCount++
    const remainingTimeout = this.requestTimeoutMs - waitTime
    const timeout = setTimeout(() => {
      next.abortController.abort(new TimeoutError(this.requestTimeoutMs))
    }, remainingTimeout)

    next.fn(next.abortController.signal)
      .then(() => next.resolve())
      .catch((err) => next.reject(err))
      .finally(() => {
        clearTimeout(timeout)
        this.activeCount--
        this.processNext()
      })
  }
}

export class QueueFullError extends Error {
  readonly queueDepth: number
  constructor(queueDepth: number) {
    super(`Queue is full (${queueDepth} requests waiting)`)
    this.name = "QueueFullError"
    this.queueDepth = queueDepth
  }
}

export class TimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`)
    this.name = "TimeoutError"
    this.timeoutMs = timeoutMs
  }
}
