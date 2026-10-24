/**
 * Host entry of `dsh-session-delete`.
 *
 * The bundle inserts exactly this row; the client half is served from `./client`.
 * All resources (the route registration and the startup registry cleanup) are owned
 * by one `ctx.effect`, so disabling the row unregisters the route instead of leaving
 * a handler behind.
 *
 * @module dsh-session-delete
 */

import { ROUTE_PREFIX, SessionDeleteService } from './lib/service.js'

/** Cordis plugin name; the bundle row id matches it. */
export const name = 'dsh-session-delete'

/**
 * Services this plugin reads. Declaring them keeps activation pending until the
 * Workspace registry, Session persistence, and Web server exist, so `apply` never
 * registers a route that cannot serve a deletion.
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence']

/**
 * Mount the deletion surface.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {Record<string, unknown>} [config] - row configuration.
 */
export function apply(ctx, config = {}) {
  const service = new SessionDeleteService(ctx, config ?? {})

  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('dsh-session-delete: the Web server service is unavailable')

    const disposeRoute = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (request, response) => {
        void service.handle(request, response).catch((error) => {
          service.log('warn', `unhandled request failure: ${error instanceof Error ? error.message : String(error)}`)
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ ok: false, error: { code: 'internal-error', message: '删除失败' } }))
          } else {
            response.destroy()
          }
        })
      },
    })

    // Converge the durable archive/pin sets on the sessions that still exist. This is
    // what removes the ids a previous purge intentionally left behind for the running UI.
    //
    // It runs on a timer instead of during apply: the Workspace table loads after the
    // services appear, and a cleanup that lands too early merely defers to the retry.
    const timers = new Set()
    const scheduleCleanup = (delayMs, attemptsLeft) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        void service.cleanupStaleRegistryIds().then(
          (result) => {
            if (result.skipped && attemptsLeft > 0) scheduleCleanup(4000, attemptsLeft - 1)
          },
          (error) => {
            service.log('warn', `startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
          },
        )
      }, delayMs)
      timer.unref?.()
      timers.add(timer)
    }
    scheduleCleanup(1500, 2)

    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  }, 'dsh-session-delete: routes')
}