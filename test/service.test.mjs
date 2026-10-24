import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { SessionDeleteService } from '../lib/service.js'
import { projectKey, spillDirectoryName } from '../lib/purge.js'

const created = []
after(async () => {
  for (const home of created) await rm(home, { recursive: true, force: true })
})

async function home() {
  const value = await mkdtemp(join(tmpdir(), 'dsh-session-delete-svc-'))
  created.push(value)
  return value
}

async function missing(target) {
  try {
    await stat(target)
    return false
  } catch {
    return true
  }
}

/** A registry double recording each archive/unarchive call. */
function createRegistry(archived = []) {
  const state = { archived: [...archived], pinned: [], archivedCalls: [], unarchiveCalls: [], unpinCalls: [] }
  return {
    get archivedSessionIds() {
      return [...state.archived]
    },
    get pinnedSessionIds() {
      return [...state.pinned]
    },
    async archiveSession(id) {
      state.archivedCalls.push(id)
      if (!state.archived.includes(id)) state.archived.push(id)
    },
    async unarchiveSession(id) {
      state.unarchiveCalls.push(id)
      state.archived = state.archived.filter((entry) => entry !== id)
    },
    async unpinSession(id) {
      state.unpinCalls.push(id)
      state.pinned = state.pinned.filter((entry) => entry !== id)
    },
    state,
  }
}

function createContext({ headers, registry, live = new Map() }) {
  return {
    logger: Object.assign(() => {}, { info() {}, warn() {} }),
    get(name) {
      if (name === 'sessionPersistence') return { list: async () => headers.map((header) => ({ header })) }
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessions') return live
      return undefined
    },
  }
}

describe('SessionDeleteService.delete', () => {
  test('archives the session and its subagent children, then removes every artifact', async () => {
    const dshHome = await home()
    const sessionsRoot = join(dshHome, 'sessions')
    const registry = createRegistry()
    const headers = [
      { id: 'session-root', cwd: 'C:\\demo' },
      { id: 'session-child', parentSession: 'session-root', origin: 'subagent', cwd: 'C:\\demo' },
      { id: 'session-fork', parentSession: 'session-root', cwd: 'C:\\demo' },
    ]
    const spillRoot = join(dshHome, 'spill')
    for (const id of ['session-root', 'session-child', 'session-fork']) {
      const dir = join(sessionsRoot, projectKey('C:\\demo'), id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), id)
    }
    await mkdir(join(dshHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(dshHome, 'storages', 'session_projcache', 'sessions', 'session-root.json'), '{}')
    const spillDir = join(spillRoot, spillDirectoryName('session-root'))
    await mkdir(spillDir, { recursive: true })
    await writeFile(join(spillDir, 'spill.txt'), 'spill')

    const service = new SessionDeleteService(
      createContext({ headers, registry }),
      { dshHome, spillRoots: [spillRoot], settleMs: 0, lateSweepMs: 0 },
    )
    const result = await service.delete('session-root', true)

    assert.equal(result.ok, true)
    assert.equal(result.found, true)
    assert.deepEqual(result.targets, ['session-root', 'session-child'])
    assert.deepEqual(registry.state.archivedCalls, ['session-root', 'session-child'])
    assert.equal(result.complete, true)
    assert.deepEqual(result.failures, [])
    assert.ok(await missing(join(sessionsRoot, projectKey('C:\\demo'), 'session-root')))
    assert.ok(await missing(join(sessionsRoot, projectKey('C:\\demo'), 'session-child')))
    // A fork is an independent conversation and survives.
    assert.equal(await missing(join(sessionsRoot, projectKey('C:\\demo'), 'session-fork')), false)
    assert.ok(await missing(join(dshHome, 'storages', 'session_projcache', 'sessions', 'session-root.json')))
    assert.ok(await missing(spillDir))
  })

  test('keeps subagent sessions when the caller declines them', async () => {
    const dshHome = await home()
    const sessionsRoot = join(dshHome, 'sessions')
    const registry = createRegistry()
    const headers = [
      { id: 'session-root', cwd: 'C:\\demo' },
      { id: 'session-child', parentSession: 'session-root', origin: 'subagent', cwd: 'C:\\demo' },
    ]
    for (const id of ['session-root', 'session-child']) {
      const dir = join(sessionsRoot, projectKey('C:\\demo'), id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.v4.jsonl.zstd'), id)
    }
    const service = new SessionDeleteService(
      createContext({ headers, registry }),
      { dshHome, settleMs: 0, lateSweepMs: 0 },
    )
    const result = await service.delete('session-root', false)
    assert.deepEqual(result.targets, ['session-root'])
    assert.deepEqual(registry.state.archivedCalls, ['session-root'])
    assert.equal(await missing(join(sessionsRoot, projectKey('C:\\demo'), 'session-child')), false)
  })

  test('previews an inventory without deleting anything', async () => {
    const dshHome = await home()
    const sessionsRoot = join(dshHome, 'sessions')
    const registry = createRegistry()
    const id = 'session-preview'
    const dir = join(sessionsRoot, projectKey('C:\\demo'), id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), '0123456789')

    const service = new SessionDeleteService(
      createContext({ headers: [{ id, cwd: 'C:\\demo' }], registry }),
      { dshHome, settleMs: 0, lateSweepMs: 0 },
    )
    const preview = await service.preview(id, true)
    assert.equal(preview.found, true)
    assert.equal(preview.sessionCount, 1)
    assert.equal(preview.artifacts.files, 1)
    assert.equal(preview.artifacts.bytes, 10)
    assert.equal(await missing(dir), false)
    assert.deepEqual(registry.state.archivedCalls, [])
  })
})

describe('SessionDeleteService.cleanupStaleRegistryIds', () => {
  test('drops archived and pinned ids whose session is gone', async () => {
    const dshHome = await home()
    const registry = createRegistry(['session-gone', 'session-kept'])
    registry.state.pinned.push('session-gone-pinned', 'session-kept')
    const sessionsRoot = join(dshHome, 'sessions')
    const kept = join(sessionsRoot, projectKey('C:\\demo'), 'session-kept')
    await mkdir(kept, { recursive: true })
    await writeFile(join(kept, 'session.v4.jsonl.zstd'), 'kept')
    const headers = [{ id: 'session-kept', cwd: 'C:\\demo' }]

    const service = new SessionDeleteService(
      createContext({ headers, registry }),
      { dshHome, settleMs: 0, lateSweepMs: 0 },
    )
    const result = await service.cleanupStaleRegistryIds()
    assert.deepEqual(result.unarchived, ['session-gone'])
    assert.deepEqual(result.unpinned, ['session-gone-pinned'])
    assert.deepEqual(registry.state.archived, ['session-kept'])
  })
})

/** Minimal request double. */
function request(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:1234' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Minimal response double capturing status and payload. */
function response() {
  const captured = { status: 0, headers: {}, body: '', headersSent: false }
  return {
    captured,
    headersSent: false,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
      this.headersSent = true
      captured.headersSent = true
    },
    end(body) {
      captured.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '')
    },
    destroy() {},
  }
}

describe('routes', () => {
  test('health reports the resolved roots', async () => {
    const dshHome = await home()
    const service = new SessionDeleteService(createContext({ headers: [], registry: createRegistry() }), {
      dshHome,
      settleMs: 0,
      lateSweepMs: 0,
    })
    const res = response()
    await service.handle(request('GET', '/.dsh-session-delete/health'), res)
    assert.equal(res.captured.status, 200)
    const payload = JSON.parse(res.captured.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.name, 'dsh-session-delete')
    assert.equal(payload.dshHome, dshHome)
  })

  test('rejects an invalid session id and a cross-origin request', async () => {
    const dshHome = await home()
    const service = new SessionDeleteService(createContext({ headers: [], registry: createRegistry() }), {
      dshHome,
      settleMs: 0,
      lateSweepMs: 0,
    })
    const bad = response()
    await service.handle(request('POST', '/.dsh-session-delete/delete', { sessionId: '../escape' }), bad)
    assert.equal(bad.captured.status, 400)
    assert.equal(JSON.parse(bad.captured.body).error.code, 'invalid-session-id')

    const foreign = request('POST', '/.dsh-session-delete/delete', { sessionId: 'session-x' })
    foreign.headers.origin = 'https://evil.example'
    const denied = response()
    await service.handle(foreign, denied)
    assert.equal(denied.captured.status, 403)
    assert.equal(JSON.parse(denied.captured.body).error.code, 'forbidden-origin')
  })

  test('deletes over HTTP and reports the artifacts it removed', async () => {
    const dshHome = await home()
    const sessionsRoot = join(dshHome, 'sessions')
    const registry = createRegistry()
    const id = 'session-http'
    const dir = join(sessionsRoot, projectKey('C:\\demo'), id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')

    const service = new SessionDeleteService(
      createContext({ headers: [{ id, cwd: 'C:\\demo' }], registry }),
      { dshHome, settleMs: 0, lateSweepMs: 0 },
    )
    const res = response()
    await service.handle(request('POST', '/.dsh-session-delete/delete', { sessionId: id }), res)
    assert.equal(res.captured.status, 200)
    const payload = JSON.parse(res.captured.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.complete, true)
    assert.deepEqual(payload.archivedSessionIds, [id])
    assert.equal(payload.files, 1)
    assert.equal(await missing(dir), true)
  })
})