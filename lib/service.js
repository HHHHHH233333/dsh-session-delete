/**
 * Host half of `dsh-session-delete`.
 *
 * The Service turns one browser request into the complete permanent deletion of a
 * Session:
 *
 *   1. archive it through the Workspace registry with `stopActivity`, which is the
 *      official way to stop turns, subagents, jobs and reminders and to hide the row
 *      from every grouping surface in the same durable write;
 *   2. remove its log directory, projection-cache record and spill directory from
 *      disk (see `./purge.js`);
 *   3. sweep once more after the projection cache's write-behind window, so a late
 *      checkpoint cannot resurrect a record;
 *   4. leave the archived id behind only until the next start, where
 *      `cleanupStaleRegistryIds()` drops every archived or pinned id whose session no
 *      longer exists.
 *
 * Routes are registered on the composed Web server under one private prefix and are
 * only reachable from this machine's GUI: the server is loopback-bound, and a
 * cross-origin `Origin` is refused here as well.
 *
 * @module dsh-session-delete/service
 */

import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import {
  discoverSpillRoots,
  findProjectionCacheFiles,
  findSessionDirectories,
  findSpillDirectories,
  measurePath,
  mergeReports,
  purgeSessionArtifacts,
} from './purge.js'

/** Private route prefix; the browser half uses the same string. */
export const ROUTE_PREFIX = '/.dsh-session-delete'

/** Plugin version reported by `/health`. */
export const VERSION = '0.1.0'

/** A Session id is a single safe, non-empty path segment no backend escapes away. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/

/** Largest accepted request body. */
const BODY_LIMIT = 64 * 1024

/** HTTP failure carrying a stable code and status. */
class HttpError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - stable machine code.
   * @param {string} message - human message.
   */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve `$DSH_HOME` the way the rest of the harness does.
 *
 * @param {Record<string, unknown>} config - row configuration.
 * @returns {string} absolute home directory.
 */
function resolveDshHome(config) {
  const configured = typeof config.dshHome === 'string' ? config.dshHome : undefined
  if (configured !== undefined && configured.length > 0) return configured
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.length > 0) return fromEnvironment
  return join(homedir(), '.dsh')
}

/** @param {number} ms - delay. @returns {Promise<void>} resolves after the delay. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {unknown} value @returns {string} a printable message. */
function describe(value) {
  return value instanceof Error ? value.message : String(value)
}

/** Read a request body as JSON with a hard size cap. */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new HttpError(413, 'body-too-large', '请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new HttpError(400, 'invalid-json', '请求体不是合法的 JSON 对象')
  }
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} value */
function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Permanently delete one Session and everything this machine stored for it.
 */
export class SessionDeleteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
   * @param {Record<string, unknown>} [config] - row configuration.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = isRecord(config) ? config : {}
    this.dshHome = resolveDshHome(this.config)
    this.sessionsRoot =
      typeof this.config.sessionsRoot === 'string' && this.config.sessionsRoot.length > 0
        ? this.config.sessionsRoot
        : join(this.dshHome, 'sessions')
    this.extraSpillRoots = Array.isArray(this.config.spillRoots)
      ? this.config.spillRoots.filter((entry) => typeof entry === 'string' && entry.length > 0)
      : []
    this.settleMs = Number.isFinite(this.config.settleMs) ? Number(this.config.settleMs) : 1200
    this.lateSweepMs = Number.isFinite(this.config.lateSweepMs) ? Number(this.config.lateSweepMs) : 6000
  }

  /**
   * Log one diagnostic through whichever shape the Cordis logger exposes.
   *
   * @param {'info' | 'warn'} level - severity.
   * @param {string} message - text.
   */
  log(level, message) {
    const line = `dsh-session-delete: ${message}`
    const logger = this.ctx.logger
    try {
      // Cordis' logger is both callable (to name a logger) and dotted with level
      // methods; the level method is the one that actually emits.
      const method = logger?.[level]
      if (typeof method === 'function') {
        method.call(logger, line)
        return
      }
      if (typeof logger === 'function') logger(line)
    } catch {
      /* logging must never fail a deletion */
    }
  }

  /** @returns {import('@deepseek-ai/cordis').Context} */
  get host() {
    return this.ctx
  }

  /** @returns {{ id: string, cwd?: string, parentSession?: string, origin?: string, createdAt?: number }[]} */
  async listHeaders() {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new HttpError(503, 'unavailable', '会话存储服务不可用')
    const snapshots = await persistence.list()
    return snapshots.map((snapshot) => snapshot.header).filter(isRecord)
  }

  /**
   * Whether a Session is live, stored, or still has a directory on disk.
   *
   * @param {string} id - Session id.
   * @param {{ id: string }[]} headers - stored headers.
   * @returns {Promise<boolean>} true when the Session exists somewhere.
   */
  async sessionExists(id, headers) {
    if (headers.some((header) => header.id === id)) return true
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if ((await findSessionDirectories(this.sessionsRoot, id)).length > 0) return true
    if ((await findProjectionCacheFiles(this.dshHome, id)).length > 0) return true
    if (this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(id)) return true
    return false
  }

  /**
   * Expand one root Session into itself plus its subagent descendants.
   *
   * Forks carry `parentSession` too, but only an agent-spawned child carries
   * `origin: 'subagent'`; a fork is an independent conversation the user may keep,
   * so it is never swept implicitly.
   *
   * @param {{ id: string, parentSession?: string, origin?: string }[]} headers - stored headers.
   * @param {string} rootId - the Session the user asked to delete.
   * @param {boolean} includeSubagents - whether agent-spawned children are included.
   * @returns {string[]} target ids, parent first, in discovery order.
   */
  collectTargets(headers, rootId, includeSubagents) {
    const targets = [rootId]
    if (!includeSubagents) return targets
    const children = new Map()
    for (const header of headers) {
      if (header.origin !== 'subagent') continue
      if (typeof header.parentSession !== 'string') continue
      const bucket = children.get(header.parentSession)
      if (bucket === undefined) children.set(header.parentSession, [header.id])
      else bucket.push(header.id)
    }
    const seen = new Set(targets)
    const queue = [rootId]
    while (queue.length > 0) {
      const parent = queue.shift()
      for (const childId of children.get(parent) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        targets.push(childId)
        queue.push(childId)
      }
    }
    return targets
  }

  /**
   * Inspect the artifacts one deletion would remove, without touching them.
   *
   * @param {string[]} targets - Session ids.
   * @returns {Promise<{
   *   sessionDirs: { path: string, files: number, bytes: number }[],
   *   cacheFiles: { path: string, files: number, bytes: number }[],
   *   spillDirs: { path: string, files: number, bytes: number }[],
   *   files: number, bytes: number,
   * }>} the inventory.
   */
  async inspect(targets) {
    const roots = await discoverSpillRoots(this.extraSpillRoots)
    const report = { sessionDirs: [], cacheFiles: [], spillDirs: [], files: 0, bytes: 0 }
    const add = async (bucket, path) => {
      const size = await measurePath(path)
      report[bucket].push({ path, ...size })
      report.files += size.files
      report.bytes += size.bytes
    }
    for (const id of targets) {
      for (const directory of await findSessionDirectories(this.sessionsRoot, id)) await add('sessionDirs', directory)
      for (const file of await findProjectionCacheFiles(this.dshHome, id)) await add('cacheFiles', file)
      for (const directory of await findSpillDirectories(roots, id)) await add('spillDirs', directory)
    }
    return report
  }

  /**
   * Hide and stop one Session through the Workspace registry.
   *
   * Archive is the only public durable operation that both hides a Session from every
   * grouping surface and asks every provider to stop its work, and its durable write
   * is what gates later wakes. An unknown session is not an error for a purge.
   *
   * @param {string} id - Session id.
   * @returns {Promise<boolean>} true when the id was written into the archive set.
   */
  async archive(id) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return false
    try {
      await registry.archiveSession(id, { stopActivity: true })
      return true
    } catch (error) {
      if (error?.name === 'WorkspaceUnknownSessionError') return false
      this.log('warn', `archive '${id}' failed: ${describe(error)}`)
      return false
    }
  }

  /**
   * Delete every artifact the given Sessions own and report what disappeared.
   *
   * @param {string[]} targets - Session ids.
   * @returns {Promise<Awaited<ReturnType<typeof purgeSessionArtifacts>>>} the report.
   */
  async purge(targets) {
    return await purgeSessionArtifacts({
      sessionsRoot: this.sessionsRoot,
      dshHome: this.dshHome,
      sessionIds: targets,
      spillRoots: this.extraSpillRoots,
      log: (message) => this.log('warn', message),
    })
  }

  /**
   * Answer one preview request: what would be removed, and how much.
   *
   * @param {string} sessionId - Session id.
   * @param {boolean} includeSubagents - whether agent-spawned children count.
   * @returns {Promise<Record<string, unknown>>} the preview payload.
   */
  async preview(sessionId, includeSubagents) {
    const headers = await this.listHeaders()
    const targets = this.collectTargets(headers, sessionId, includeSubagents)
    const inventory = await this.inspect(targets)
    const archived = this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(sessionId) === true
    return {
      ok: true,
      sessionId,
      found: await this.sessionExists(sessionId, headers),
      archived,
      sessionCount: targets.length,
      subagentCount: targets.length - 1,
      targets,
      artifacts: inventory,
    }
  }

  /**
   * Delete one Session and its artifacts.
   *
   * @param {string} sessionId - Session id.
   * @param {boolean} includeSubagents - also delete agent-spawned children.
   * @returns {Promise<Record<string, unknown>>} the deletion report.
   */
  async delete(sessionId, includeSubagents) {
    const headers = await this.listHeaders()
    const targets = this.collectTargets(headers, sessionId, includeSubagents)
    const found = await this.sessionExists(sessionId, headers)

    // 1. Hide + stop. Parent first, so its children are already being stopped by the
    //    time their own rows are archived.
    const archived = []
    for (const id of targets) {
      if (await this.archive(id)) archived.push(id)
    }

    // 2. Let the stops settle: a turn or subagent that is still unwinding would
    //    otherwise recreate the log directory right after this sweep.
    await delay(this.settleMs)

    // 3. Remove the artifacts, then sweep again right away to catch a checkpoint
    //    that landed while the first pass ran.
    let report = await this.purge(targets)
    await delay(450)
    report = mergeReports(report, await this.purge(targets))

    // 4. The projection cache's write-behind interval is 5s; one background sweep
    //    after that window makes a late checkpoint unable to resurrect a record.
    //    It is fire-and-forget: the user already waited once.
    const background = this.lateSweepMs > 0
    if (background) {
      const timer = setTimeout(() => {
        void this.purge(targets).then(
          (late) => {
            if (late.failures.length > 0) {
              this.log('warn', `late sweep left ${String(late.failures.length)} artifact(s) for '${sessionId}'`)
            }
          },
          (error) => this.log('warn', `late sweep failed for '${sessionId}': ${describe(error)}`),
        )
      }, this.lateSweepMs)
      timer.unref?.()
    }

    return {
      ok: true,
      sessionId,
      found,
      archivedSessionIds: archived,
      targets,
      artifacts: {
        sessionDirs: report.sessionDirs,
        cacheFiles: report.cacheFiles,
        spillDirs: report.spillDirs,
        projectDirs: report.projectDirs,
      },
      files: report.files,
      bytes: report.bytes,
      complete: report.failures.length === 0,
      failures: report.failures,
      backgroundSweep: background,
    }
  }

  /**
   * Drop archived and pinned ids whose Session no longer exists.
   *
   * The purge leaves its archived id in place so the running UI keeps the row
   * hidden until the restart that reloads the registry; this start-time pass is
   * what makes the durable sets converge on the files that actually exist.
   *
   * @returns {Promise<{ unarchived: string[], unpinned: string[], skipped: boolean }>} the cleanup outcome.
   */
  async cleanupStaleRegistryIds() {
    const result = { unarchived: [], unpinned: [], skipped: false }
    const registry = this.ctx.get('workspaceRegistry')
    const persistence = this.ctx.get('sessionPersistence')
    if (registry === undefined || persistence === undefined) {
      result.skipped = true
      return result
    }
    let headers
    try {
      headers = await this.listHeaders()
    } catch (error) {
      this.log('warn', `startup cleanup skipped: ${describe(error)}`)
      result.skipped = true
      return result
    }
    const known = new Set(headers.map((header) => header.id))
    let archived
    let pinned
    try {
      // Both getters read the durable table; a registry that is still loading throws
      // here, which is a reason to skip this round rather than to fail the boot.
      archived = [...registry.archivedSessionIds]
      pinned = [...registry.pinnedSessionIds]
    } catch (error) {
      this.log('warn', `startup cleanup deferred: ${describe(error)}`)
      result.skipped = true
      return result
    }
    for (const id of archived) {
      if (known.has(id)) continue
      if (this.ctx.get('sessions')?.get(id) !== undefined) continue
      if ((await findSessionDirectories(this.sessionsRoot, id)).length > 0) continue
      try {
        await registry.unarchiveSession(id)
        result.unarchived.push(id)
      } catch (error) {
        this.log('warn', `unarchive stale '${id}' failed: ${describe(error)}`)
      }
    }
    for (const id of pinned) {
      if (known.has(id)) continue
      if (this.ctx.get('sessions')?.get(id) !== undefined) continue
      if ((await findSessionDirectories(this.sessionsRoot, id)).length > 0) continue
      try {
        await registry.unpinSession(id)
        result.unpinned.push(id)
      } catch (error) {
        this.log('warn', `unpin stale '${id}' failed: ${describe(error)}`)
      }
    }
    if (result.unarchived.length > 0 || result.unpinned.length > 0) {
      this.log('info', `startup cleanup: ${result.unarchived.length} archived and ${result.unpinned.length} pinned stale id(s)`)
    }
    return result
  }

  /**
   * Refuse a request that a foreign page initiated.
   *
   * The listener is loopback-bound, but a browser on this machine could still try a
   * cross-origin POST; a mismatched `Origin` is rejected. The Electron shell and
   * same-origin requests either omit the header or use a local scheme.
   *
   * @param {import('node:http').IncomingMessage} request - the request.
   */
  assertOrigin(request) {
    const origin = request.headers.origin
    if (typeof origin !== 'string' || origin.length === 0) return
    if (origin === 'null') return
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      throw new HttpError(403, 'forbidden-origin', '请求来源不被允许')
    }
    if (parsed.protocol === 'file:' || parsed.protocol === 'app:') return
    const host = request.headers.host
    if (typeof host === 'string' && parsed.host === host) return
    throw new HttpError(403, 'forbidden-origin', '请求来源不被允许')
  }

  /**
   * Route one HTTP request.
   *
   * @param {import('node:http').IncomingMessage} request - the request.
   * @param {import('node:http').ServerResponse} response - the response.
   * @returns {Promise<void>} settles after the response is written.
   */
  async handle(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.replace(/\/+$/, '')
      if (route === `${ROUTE_PREFIX}/health`) {
        if (request.method !== 'GET') throw new HttpError(405, 'method-not-allowed', '只支持 GET')
        sendJson(response, 200, {
          ok: true,
          name: 'dsh-session-delete',
          version: VERSION,
          dshHome: this.dshHome,
          sessionsRoot: this.sessionsRoot,
        })
        return
      }
      if (route === `${ROUTE_PREFIX}/preview`) {
        if (request.method !== 'GET') throw new HttpError(405, 'method-not-allowed', '只支持 GET')
        this.assertOrigin(request)
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (!SESSION_ID.test(sessionId)) throw new HttpError(400, 'invalid-session-id', '会话 id 不合法')
        const include = url.searchParams.get('subagents') !== '0'
        sendJson(response, 200, await this.preview(sessionId, include))
        return
      }
      if (route === `${ROUTE_PREFIX}/delete`) {
        if (request.method !== 'POST') throw new HttpError(405, 'method-not-allowed', '只支持 POST')
        this.assertOrigin(request)
        const body = await readJson(request)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!SESSION_ID.test(sessionId)) throw new HttpError(400, 'invalid-session-id', '会话 id 不合法')
        const include = body.deleteSubagents !== false
        sendJson(response, 200, await this.delete(sessionId, include))
        return
      }
      throw new HttpError(404, 'not-found', `未知路由 ${basename(route)}`)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const code = error instanceof HttpError ? error.code : 'internal-error'
      if (status >= 500) this.log('warn', `request failed: ${describe(error)}`)
      if (!response.headersSent) {
        sendJson(response, status, { ok: false, error: { code, message: describe(error) } })
      } else {
        response.destroy()
      }
    }
  }
}