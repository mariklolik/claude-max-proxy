import { logger } from "../logger"

interface PooledSession {
  sessionId: string
  model: string
  lastUsed: number
  inUse: boolean
}

export class SessionPool {
  private sessions = new Map<string, PooledSession[]>()
  private readonly ttlMs: number
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? parseInt(process.env.CLAUDE_PROXY_SESSION_TTL_MS || "600000", 10)
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  acquire(model: string): string | undefined {
    const pool = this.sessions.get(model)
    if (!pool) return undefined
    const now = Date.now()
    for (const session of pool) {
      if (!session.inUse && now - session.lastUsed < this.ttlMs) {
        session.inUse = true
        session.lastUsed = now
        logger.debug("session.reused", { model, sessionId: session.sessionId })
        return session.sessionId
      }
    }
    return undefined
  }

  register(model: string, sessionId: string): void {
    if (!this.sessions.has(model)) this.sessions.set(model, [])
    this.sessions.get(model)!.push({ sessionId, model, lastUsed: Date.now(), inUse: false })
    logger.debug("session.registered", { model, sessionId })
  }

  release(sessionId: string): void {
    for (const pool of this.sessions.values()) {
      const session = pool.find((s) => s.sessionId === sessionId)
      if (session) { session.inUse = false; session.lastUsed = Date.now(); return }
    }
  }

  invalidate(sessionId: string): void {
    for (const [model, pool] of this.sessions.entries()) {
      const idx = pool.findIndex((s) => s.sessionId === sessionId)
      if (idx >= 0) { pool.splice(idx, 1); logger.debug("session.invalidated", { model, sessionId }); return }
    }
  }

  stats(): { total: number; inUse: number; byModel: Record<string, number> } {
    let total = 0, inUse = 0
    const byModel: Record<string, number> = {}
    for (const [model, pool] of this.sessions.entries()) {
      byModel[model] = pool.length
      total += pool.length
      inUse += pool.filter((s) => s.inUse).length
    }
    return { total, inUse, byModel }
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [model, pool] of this.sessions.entries()) {
      const before = pool.length
      const remaining = pool.filter((s) => s.inUse || now - s.lastUsed < this.ttlMs)
      if (remaining.length < before) {
        this.sessions.set(model, remaining)
        logger.debug("session.cleanup", { model, evicted: before - remaining.length, remaining: remaining.length })
      }
    }
  }

  destroy(): void { clearInterval(this.cleanupTimer); this.sessions.clear() }
}
