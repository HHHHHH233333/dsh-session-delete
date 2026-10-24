import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { describe, test } from 'node:test'

/**
 * Mount the Host half on a real Cordis context.
 *
 * The desktop app cannot be started twice, so this file borrows the Cordis runtime
 * from the installed build and provides the three services the plugin injects. It is
 * the closest local equivalent of a real profile mount: a wrong `inject` name would
 * leave the plugin pending, and the route assertion would fail.
 */

const CORDIS_CANDIDATES = [
  process.env.DSH_CORDIS_ENTRY,
  'C:/AI/deepseekAI/AI1/_asar/extract/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
  'C:/deepseekharness/DSH/resources/app.asar.extracted/node_modules/@deepseek-ai/cordis/lib/index.js',
].filter((entry) => typeof entry === 'string')

async function loadCordis() {
  for (const candidate of CORDIS_CANDIDATES) {
    if (!existsSync(candidate)) continue
    try {
      return await import(new URL(`file:///${candidate.replaceAll('\\', '/')}`).href)
    } catch {
      continue
    }
  }
  return null
}

/** Wait until `check()` returns true, or fail after a short budget. */
async function settle(check, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`${label} did not happen`)
}

describe('cordis mount', async () => {
  const cordis = await loadCordis()
  if (cordis === null) {
    test('skipped: no Cordis runtime found', { skip: true }, () => {})
    return
  }
  const host = await import('../index.js')

  test('the plugin shape matches the loader contract', () => {
    assert.equal(host.name, 'dsh-session-delete')
    assert.deepEqual(host.inject, ['webServer', 'workspaceRegistry', 'sessionPersistence'])
    assert.equal(typeof host.apply, 'function')
  })

  test('registers exactly one route and removes it on disposal', async () => {
    const context = new cordis.Context()
    const routes = []
    const disposals = []
    context.provide('webServer', {
      register(options) {
        routes.push(options)
        return () => disposals.push(options)
      },
    })
    context.provide('workspaceRegistry', {
      archivedSessionIds: [],
      pinnedSessionIds: [],
      async archiveSession() {},
      async unarchiveSession() {},
      async unpinSession() {},
    })
    context.provide('sessionPersistence', { list: async () => [] })

    const fiber = context.plugin(host)
    await settle(() => routes.length > 0, 'route registration')

    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/.dsh-session-delete')
    assert.equal(typeof routes[0].handler, 'function')

    await fiber.dispose()
    await settle(() => disposals.length > 0, 'route disposal')
  })

  test('answers health through the mounted handler', async () => {
    const context = new cordis.Context()
    let handler = null
    context.provide('webServer', {
      register(options) {
        handler = options.handler
        return () => {}
      },
    })
    context.provide('workspaceRegistry', {
      archivedSessionIds: [],
      pinnedSessionIds: [],
      async archiveSession() {},
      async unarchiveSession() {},
      async unpinSession() {},
    })
    context.provide('sessionPersistence', { list: async () => [] })

    context.plugin(host)
    await settle(() => handler !== null, 'route registration')

    const captured = { status: 0, body: '' }
    const response = {
      headersSent: false,
      writeHead(status) {
        captured.status = status
        this.headersSent = true
      },
      end(body) {
        captured.body = String(body ?? '')
      },
      destroy() {},
    }
    const request = {
      method: 'GET',
      url: '/.dsh-session-delete/health',
      headers: { host: '127.0.0.1:1' },
      async *[Symbol.asyncIterator]() {},
    }
    await handler(request, response)
    assert.equal(captured.status, 200)
    assert.equal(JSON.parse(captured.body).name, 'dsh-session-delete')
    await context.dispose?.()
  })
})

