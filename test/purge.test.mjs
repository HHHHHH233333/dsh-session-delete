import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  encodeSegment,
  findProjectionCacheFiles,
  findSessionDirectories,
  mergeReports,
  projectKey,
  purgeSessionArtifacts,
  sessionDirectory,
  spillDirectoryName,
} from '../lib/purge.js'
import { SessionDeleteService } from '../lib/service.js'

/** One synthetic `$DSH_HOME` that every case can build on. */
async function createHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-test-'))
  const sessionsRoot = join(home, 'sessions')
  await mkdir(join(sessionsRoot, projectKey('C:\\demo')), { recursive: true })
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  return {
    home,
    sessionsRoot,
    sessionLog(id, cwd = 'C:\\demo') {
      const directory = sessionDirectory(sessionsRoot, cwd, id)
      return mkdir(directory, { recursive: true }).then(() =>
        writeFile(join(directory, 'session.v4.jsonl.zstd'), `log:${id}`),
      )
    },
    cache(id) {
      return writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), JSON.stringify({ id }))
    },
  }
}

const created = []
after(async () => {
  for (const home of created) await rm(home, { recursive: true, force: true })
})

/** @returns {Promise<ReturnType<typeof createHome> extends Promise<infer T> ? T : never>} */
async function home() {
  const value = await createHome()
  created.push(value.home)
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

describe('path encoding', () => {
  test('mirrors the shipped project directory key', () => {
    assert.equal(projectKey('C:\\AI\\deepseekAI\\AI1'), '--C-AI-deepseekAI-AI1--')
    assert.equal(projectKey('/home/me/demo'), '--home-me-demo--')
    assert.equal(projectKey('C:/'), '--C---')
  })

  test('keeps safe ids literal and escapes everything else', () => {
    assert.equal(encodeSegment('session-8fc996c0-8e3f-481a-a351-737d9c1bfd44'), 'session-8fc996c0-8e3f-481a-a351-737d9c1bfd44')
    assert.equal(encodeSegment('..'), '~002E~002E')
    assert.equal(encodeSegment('a/b'), 'a~002Fb')
    assert.equal(encodeSegment('a~b'), 'a~007Eb')
  })

  test('derives the spill directory name from the session id', () => {
    assert.match(spillDirectoryName('session-x'), /^session-[0-9a-f]{12}$/)
  })
})

describe('purge', () => {
  test('removes the log, cache, and spill directory of one session', async () => {
    const fixture = await home()
    const id = 'session-aaaaaaaa-0001'
    await fixture.sessionLog(id)
    await fixture.cache(id)
    const spillRoot = join(fixture.home, 'tmp-spill')
    const spillDir = join(spillRoot, spillDirectoryName(id))
    await mkdir(spillDir, { recursive: true })
    await writeFile(join(spillDir, 'tool-output.txt'), 'x'.repeat(2048))

    assert.equal((await findSessionDirectories(fixture.sessionsRoot, id)).length, 1)
    assert.equal((await findProjectionCacheFiles(fixture.home, id)).length, 1)

    const report = await purgeSessionArtifacts({
      sessionsRoot: fixture.sessionsRoot,
      dshHome: fixture.home,
      sessionIds: [id],
      spillRoots: [spillRoot],
    })

    assert.equal(report.failures.length, 0)
    assert.equal(report.sessionDirs.length, 1)
    assert.equal(report.cacheFiles.length, 1)
    assert.equal(report.spillDirs.length, 1)
    assert.equal(report.bytes, 2048 + `log:${id}`.length + JSON.stringify({ id }).length)
    assert.equal(report.files, 3)
    assert.ok(await missing(report.sessionDirs[0]))
    assert.ok(await missing(report.cacheFiles[0]))
    assert.ok(await missing(report.spillDirs[0]))
  })

  test('removes a quarantined backup of the cache document too', async () => {
    const fixture = await home()
    const id = 'session-ffffffff-0006'
    await fixture.cache(id)
    const backup = join(fixture.home, 'storages', 'session_projcache', 'sessions', `${id}.json.bak.202601011200`)
    await writeFile(backup, '{}')
    // A different session's backup must survive a neighbouring purge.
    const other = join(fixture.home, 'storages', 'session_projcache', 'sessions', 'session-other.json.bak.202601011200')
    await writeFile(other, '{}')

    const files = await findProjectionCacheFiles(fixture.home, id)
    assert.deepEqual(files.sort(), [backup, join(fixture.home, 'storages', 'session_projcache', 'sessions', `${id}.json`)].sort())

    const report = await purgeSessionArtifacts({
      sessionsRoot: fixture.sessionsRoot,
      dshHome: fixture.home,
      sessionIds: [id],
      spillRoots: [],
    })
    assert.equal(report.cacheFiles.length, 2)
    assert.ok(await missing(backup))
    assert.equal(await missing(other), false)
  })

  test('finds a session under a project directory it did not derive', async () => {
    const fixture = await home()
    const id = 'session-bbbbbbbb-0002'
    // A different cwd spelling still lands the directory the backend chose.
    await fixture.sessionLog(id, 'D:\\somewhere\\else')

    const report = await purgeSessionArtifacts({
      sessionsRoot: fixture.sessionsRoot,
      dshHome: fixture.home,
      sessionIds: [id],
      spillRoots: [],
    })
    assert.equal(report.sessionDirs.length, 1)
    assert.equal(report.failures.length, 0)
    assert.ok(await missing(report.sessionDirs[0]))
  })

  test('leaves a shared project directory in place and is idempotent', async () => {
    const fixture = await home()
    const first = 'session-cccccccc-0003'
    const second = 'session-dddddddd-0004'
    await fixture.sessionLog(first)
    await fixture.sessionLog(second)

    const one = await purgeSessionArtifacts({
      sessionsRoot: fixture.sessionsRoot,
      dshHome: fixture.home,
      sessionIds: [first],
      spillRoots: [],
    })
    assert.equal(one.projectDirs.length, 0)
    assert.equal((await findSessionDirectories(fixture.sessionsRoot, second)).length, 1)

    const again = await purgeSessionArtifacts({
      sessionsRoot: fixture.sessionsRoot,
      dshHome: fixture.home,
      sessionIds: [first],
      spillRoots: [],
    })
    assert.equal(again.sessionDirs.length, 0)
    assert.equal(again.failures.length, 0)
  })

  test('removes an emptied project directory after the last session', async () => {
    const fixture = await home()
    const id = 'session-eeeeeeee-0005'
    await fixture.sessionLog(id, 'E:\\solo')
    const directory = sessionDirectory(fixture.sessionsRoot, 'E:\\solo', id)

    const report = await purgeSessionArtifacts({
      sessionsRoot: fixture.sessionsRoot,
      dshHome: fixture.home,
      sessionIds: [id],
      spillRoots: [],
    })
    assert.equal(report.projectDirs.length, 1)
    assert.ok(await missing(join(directory, '..')))
  })
})

describe('merge', () => {
  test('unions paths and sums counters', () => {
    const base = { sessionDirs: ['a'], cacheFiles: ['c'], spillDirs: [], projectDirs: [], files: 2, bytes: 10, failures: [] }
    const next = { sessionDirs: ['a', 'b'], cacheFiles: [], spillDirs: ['s'], projectDirs: ['p'], files: 1, bytes: 5, failures: [{ path: 'z', message: 'locked' }] }
    const merged = mergeReports(base, next)
    assert.deepEqual(merged.sessionDirs, ['a', 'b'])
    assert.deepEqual(merged.spillDirs, ['s'])
    assert.equal(merged.files, 3)
    assert.equal(merged.bytes, 15)
    assert.equal(merged.failures.length, 1)
  })
})

describe('target collection', () => {
  const service = new SessionDeleteService({ get: () => undefined, logger: Object.assign(() => {}, { warn() {}, info() {} }) }, {})

  test('includes nested subagent children and excludes forks', () => {
    const headers = [
      { id: 'root' },
      { id: 'fork', parentSession: 'root' },
      { id: 'child-1', parentSession: 'root', origin: 'subagent' },
      { id: 'grandchild', parentSession: 'child-1', origin: 'subagent' },
      { id: 'unrelated', parentSession: 'elsewhere', origin: 'subagent' },
    ]
    assert.deepEqual(service.collectTargets(headers, 'root', true), ['root', 'child-1', 'grandchild'])
    assert.deepEqual(service.collectTargets(headers, 'root', false), ['root'])
  })
})