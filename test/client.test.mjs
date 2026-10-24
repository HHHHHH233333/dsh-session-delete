import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

/**
 * Smoke tests for the browser bundle.
 *
 * The bundle is not importable on its own — it talks to the shell's module loader
 * and to React — so this file installs the smallest fakes that make the factory and
 * its two seats observable. It catches the failures that would otherwise only show
 * up as an empty menu inside the running app: a broken factory, a missing seat, or a
 * component that throws on its first render.
 */

/** A React stand-in that renders function components eagerly. */
function createReact() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement(type, props, ...children) {
      const element = { type, props: { ...(props ?? {}), children } }
      if (typeof type === 'function') return type(element.props)
      return element
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
  }
}

function createDocument() {
  const created = []
  return {
    created,
    getElementById: () => null,
    createElement: (tag) => {
      const element = { tag, id: '', textContent: '', remove() {} }
      created.push(element)
      return element
    },
    head: { append() {} },
  }
}

/**
 * Load the bundle with the given primitives module.
 *
 * @param {{ MenuItemButton?: unknown }} primitives - what `require('@deepseek-ai/dsh-client-ui-primitives')` returns.
 * @param {string} cacheKey - URL suffix that forces a fresh module instance.
 */
async function loadBundle(primitives, cacheKey) {
  let definition = null
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  globalThis.document = createDocument()
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          found: true,
          sessionCount: 2,
          subagentCount: 1,
          artifacts: { files: 3, bytes: 4096 },
        }),
    }
  }
  const React = createReact()
  const require = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${id}`)
  }
  await import(new URL(`../client.js?${cacheKey}`, import.meta.url).href)
  assert.ok(definition !== null, 'the bundle must call __ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-session-delete')
  return { module: definition.factory(require), calls, React }
}

/** Collect the seats a module registers on a fake slot service. */
function createClientContext() {
  const registrations = []
  const disposers = []
  const injections = []
  return {
    registrations,
    injections,
    disposers,
    ctx: {
      effect(callback) {
        const dispose = callback()
        dispose === undefined ? undefined : disposers.push(dispose)
        return dispose
      },
      slots: {
        inject(name, callback) {
          injections.push(name)
          return callback()
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

beforeEach(() => {
  delete globalThis.fetch
})

afterEach(() => {
  delete globalThis.window
  delete globalThis.document
  delete globalThis.fetch
})

describe('client bundle', () => {
  test('registers the menu row and the confirmation dialog', async () => {
    const { module } = await loadBundle({ MenuItemButton: () => null }, 'main')
    assert.deepEqual(module.inject, ['slots'])
    const { ctx, registrations, injections } = createClientContext()
    module.apply(ctx)

    assert.deepEqual(injections, ['sidebar.workspaces.session.menu.item', 'shell.overlay'])
    assert.equal(registrations.length, 2)
    const [menu, overlay] = registrations
    assert.equal(menu.options.name, 'sidebar.workspaces.session.menu.item')
    assert.equal(menu.options.id, 'session-delete')
    assert.equal(menu.options.order, 500)
    assert.equal(overlay.options.name, 'shell.overlay')
    assert.equal(overlay.options.id, 'session-delete.confirm')

    // The id is package-namespaced and must not shadow a shipped row.
    assert.ok(!['pin', 'rename', 'fork', 'archive', 'session-id'].includes(menu.options.id))
  })

  test('renders an inert dialog before anything is opened', async () => {
    const { module } = await loadBundle({ MenuItemButton: () => null }, 'inert')
    const { ctx, registrations } = createClientContext()
    module.apply(ctx)
    const overlay = registrations[1].component
    assert.equal(overlay({}), null)
  })

  test('renders the menu row through the primitives button and asks for a preview', async () => {
    const MenuItemButton = (props) => ({ kind: 'MenuItemButton', props })
    const { module, calls } = await loadBundle({ MenuItemButton }, 'menu')
    const { ctx, registrations } = createClientContext()
    module.apply(ctx)
    const menu = registrations[0].component

    let closed = false
    const element = menu({
      sessionId: 'session-abc',
      displayTitle: '示例会话',
      useMenuOpenState: () => [true, (value) => { closed = value === false }],
    })
    assert.equal(element.kind, 'MenuItemButton')
    assert.equal(element.props.separatorBefore, true)
    assert.equal(typeof element.props.onSelect, 'function')

    element.props.onSelect()
    assert.equal(closed, true, 'the row menu must close before the dialog opens')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /^\/\.dsh-session-delete\/preview\?sessionId=session-abc&subagents=1$/)
  })

  test('falls back to a plain menuitem button without the primitives package', async () => {
    const { module } = await loadBundle(null, 'fallback')
    const { ctx, registrations } = createClientContext()
    module.apply(ctx)
    const menu = registrations[0].component
    const element = menu({
      sessionId: 'session-abc',
      displayTitle: 'x',
      useMenuOpenState: () => [true, () => {}],
    })
    assert.equal(element.type, 'button')
    assert.equal(element.props.role, 'menuitem')
    assert.match(element.props.className, /dsh-sd-item/)
  })

  test('removes its stylesheet and store listeners when disposed', async () => {
    const { module } = await loadBundle({ MenuItemButton: () => null }, 'dispose')
    const { ctx, disposers } = createClientContext()
    module.apply(ctx)
    assert.equal(disposers.length, 1)
    assert.equal(typeof disposers[0], 'function')
    assert.doesNotThrow(() => disposers[0]())
  })
})