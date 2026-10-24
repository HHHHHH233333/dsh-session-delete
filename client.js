/**
 * Browser half of `dsh-session-delete`.
 *
 * The shell registers this bundle through `window.__ModuleLoader__.load({ id, factory })`;
 * the factory receives the platform baseline (`react` among it) and returns the
 * Cordis-shaped module `{ name, inject, apply }`.
 *
 * Two seats are contributed:
 *
 *   - `sidebar.workspaces.session.menu.item` — the confirmed entry beside Archive.
 *   - `shell.overlay` — the confirmation dialog and its progress/error/toast, kept
 *     outside the row so closing the menu cannot unmount it mid-request.
 *
 * A row disappears after deletion because the Host archives the session first: the
 * shipped Workspace browser hides archived rows under its default filter, and the
 * archive is the durable state that also gates any later wake.
 */

const PREFIX = '/.dsh-session-delete'

/** Copy for the two supported UI languages. */
const COPY = {
  zh: {
    menu: '彻底删除会话…',
    title: '彻底删除这个会话？',
    desc: '“{title}”的聊天记录、标题与统计缓存、以及它产生的临时文件都会从这台电脑上删除。',
    irreversible: '删除后无法恢复，也无法再搜索或恢复这段对话。',
    subagents: '同时删除它派生的子代理会话（{n} 个）',
    inventory: '将删除 {sessions} 个会话、{files} 个文件（{size}）。',
    inventoryEmpty: '本机上没有找到这个会话的残留文件。',
    cancel: '取消',
    confirm: '彻底删除',
    working: '正在删除…',
    done: '会话已彻底删除。',
    donePartial: '会话已删除，但有 {n} 个文件被占用未能删除，请重启应用后重试。',
    doneMissing: '本机已没有这个会话的记录。',
    failed: '删除失败：{message}',
    close: '关闭',
  },
  en: {
    menu: 'Delete permanently…',
    title: 'Delete this session permanently?',
    desc: 'The chat log, title and statistics cache, and temporary files produced by “{title}” will be removed from this computer.',
    irreversible: 'This cannot be undone, and the conversation will no longer be searchable or recoverable.',
    subagents: 'Also delete the subagent sessions it spawned ({n})',
    inventory: 'Removes {sessions} session(s) and {files} file(s) ({size}).',
    inventoryEmpty: 'No leftover files for this session were found on this machine.',
    cancel: 'Cancel',
    confirm: 'Delete permanently',
    working: 'Deleting…',
    done: 'Session deleted permanently.',
    donePartial: 'The session was deleted, but {n} file(s) were locked. Restart the app and try again.',
    doneMissing: 'This machine no longer has a record of this session.',
    failed: 'Delete failed: {message}',
    close: 'Close',
  },
}

/** @returns {typeof COPY['zh']} the dictionary for the current UI language. */
function dictionary() {
  try {
    const language = String(globalThis.navigator?.language ?? 'en')
    return language.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
  } catch {
    return COPY.en
  }
}

/** @param {string} template @param {Record<string, string | number>} values @returns {string} */
function format(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
}

/** @param {number} bytes @returns {string} a short human size. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Stylesheet the bundle owns while it is applied. */
const STYLE_ID = 'dsh-session-delete-styles'

const STYLES = `
.dsh-sd-item{display:flex;align-items:center;gap:8px;width:100%;margin:0;padding:7px 12px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-sd-item:hover,.dsh-sd-item:focus-visible{background:rgba(128,128,128,.16);outline:none}
.dsh-sd-item-separated{margin-top:4px;border-top:1px solid rgba(128,128,128,.22);border-radius:0 0 6px 6px;padding-top:9px}
.dsh-sd-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}
.dsh-sd-panel{width:min(470px,100%);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;padding:22px 22px 16px;border:1px solid rgba(128,128,128,.35);border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 24px 60px rgba(0,0,0,.4);font:14px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.dsh-sd-title{margin:0 0 8px;font-size:17px;font-weight:600;line-height:1.4}
.dsh-sd-desc{margin:0 0 10px;opacity:.86}
.dsh-sd-warning{margin:10px 0 0;padding:9px 12px;border-radius:9px;border:1px solid rgba(220,80,60,.35);background:rgba(220,80,60,.1);color:inherit;font-size:13px}
.dsh-sd-inventory{margin:12px 0 0;padding:10px 12px;border-radius:9px;background:rgba(128,128,128,.12);font-size:13px;opacity:.9}
.dsh-sd-check{display:flex;align-items:flex-start;gap:8px;margin:14px 0 0;font-size:13px;cursor:pointer}
.dsh-sd-check input{margin:3px 0 0}
.dsh-sd-error{margin:12px 0 0;color:#d9534f;font-size:13px;white-space:pre-wrap;word-break:break-word}
.dsh-sd-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.dsh-sd-button{appearance:none;border:1px solid rgba(128,128,128,.45);border-radius:8px;background:transparent;color:inherit;font:inherit;padding:7px 16px;cursor:pointer}
.dsh-sd-button:hover{background:rgba(128,128,128,.14)}
.dsh-sd-button:disabled{opacity:.55;cursor:default}
.dsh-sd-danger{border-color:rgba(217,83,79,.75);background:#d9534f;color:#fff}
.dsh-sd-danger:hover{background:#c9302c}
.dsh-sd-toast{position:fixed;left:50%;bottom:48px;z-index:2147483001;transform:translateX(-50%);max-width:min(520px,90vw);padding:10px 18px;border-radius:999px;background:rgba(30,30,30,.94);color:#fff;font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35)}
`

window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    // `@deepseek-ai/dsh-client-ui-primitives` is a baseline external. Its MenuItemButton
    // keeps the entry visually identical to the shipped Archive row; when it is absent
    // (an older shell) the plain role="menuitem" button below still works.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    const MenuItemButton =
      primitives !== null && typeof primitives.MenuItemButton === 'function' ? primitives.MenuItemButton : null
    // The shipped rows all carry a 14px icon; matching them keeps the destructive row
    // part of the list instead of a plain-text outlier.
    const IconTrash =
      primitives !== null && typeof primitives.IconTrashOutlineRegular === 'function'
        ? primitives.IconTrashOutlineRegular
        : null

    /**
     * One tiny observable store shared by the menu entry and the overlay.
     *
     * The dialog outlives the menu item that opened it, so its state cannot live in
     * that component; the store keeps one pending request and notifies both seats.
     */
    function createStore() {
      let state = {
        open: false,
        sessionId: null,
        title: '',
        includeSubagents: true,
        preview: null,
        previewing: false,
        busy: false,
        error: null,
        toast: null,
        toastKind: 'info',
      }
      const listeners = new Set()
      let toastTimer = null
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch }
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        notify(text, kind = 'info') {
          if (toastTimer !== null) clearTimeout(toastTimer)
          state = { ...state, toast: text, toastKind: kind }
          for (const listener of listeners) listener()
          toastTimer = setTimeout(() => {
            toastTimer = null
            state = { ...state, toast: null }
            for (const listener of listeners) listener()
          }, 5000)
        },
        dispose() {
          if (toastTimer !== null) clearTimeout(toastTimer)
          toastTimer = null
          listeners.clear()
        },
      }
    }

    /** Subscribe one component to the store snapshot. */
    function useStore(store) {
      const [snapshot, setSnapshot] = useState(store.get())
      useEffect(() => store.subscribe(() => setSnapshot(store.get())), [store])
      return snapshot
    }

    /** Dismiss the row menu the entry was rendered in, when the slot offers that hook. */
    function useCloseMenu(useMenuOpenState) {
      // Hooks must run unconditionally; the slot always supplies this hook for menu items.
      const pair = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null
      return () => {
        if (Array.isArray(pair) && typeof pair[1] === 'function') pair[1](false)
      }
    }

    /** @param {unknown} value @returns {string} */
    function messageOf(value) {
      return value instanceof Error ? value.message : String(value)
    }

    /**
     * Read one JSON response, tolerating an HTML error page from a missing route.
     */
    async function readResponse(response) {
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: { code: `http-${String(response.status)}`, message: text.slice(0, 200) } }
      }
    }

    /** @param {string} sessionId @param {boolean} subagents @returns {Promise<Record<string, unknown>>} */
    async function fetchPreview(sessionId, subagents) {
      const query = `sessionId=${encodeURIComponent(sessionId)}&subagents=${subagents ? '1' : '0'}`
      const response = await fetch(`${PREFIX}/preview?${query}`, { method: 'GET', headers: { accept: 'application/json' } })
      return await readResponse(response)
    }

    /** @param {{ sessionId: string, deleteSubagents: boolean }} input @returns {Promise<Record<string, unknown>>} */
    async function postDelete(input) {
      const response = await fetch(`${PREFIX}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      })
      return await readResponse(response)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const store = createStore()
        const copy = dictionary()

        const open = (sessionId, title) => {
          store.set({
            open: true,
            sessionId,
            title: typeof title === 'string' && title.length > 0 ? title : copy.menu,
            includeSubagents: true,
            preview: null,
            previewing: true,
            busy: false,
            error: null,
          })
          void fetchPreview(sessionId, true)
            .then((preview) => {
              if (store.get().sessionId !== sessionId) return
              store.set({ preview, previewing: false })
            })
            .catch((error) => {
              if (store.get().sessionId !== sessionId) return
              store.set({ preview: null, previewing: false })
              store.set({ error: format(copy.failed, { message: messageOf(error) }) })
            })
        }

        const close = () => {
          if (store.get().busy) return
          store.set({ open: false, error: null, preview: null, sessionId: null })
        }

        const confirm = async () => {
          const snapshot = store.get()
          const sessionId = snapshot.sessionId
          if (typeof sessionId !== 'string' || sessionId.length === 0) return
          store.set({ busy: true, error: null })
          try {
            const result = await postDelete({ sessionId, deleteSubagents: snapshot.includeSubagents })
            if (result?.ok !== true) {
              throw new Error(result?.error?.message ?? 'HTTP error')
            }
            store.set({ busy: false, open: false, preview: null, sessionId: null })
            if (result.found === false) store.notify(copy.doneMissing, 'info')
            else if (result.complete === false) {
              store.notify(format(copy.donePartial, { n: Array.isArray(result.failures) ? result.failures.length : 0 }), 'warn')
            } else store.notify(copy.done, 'success')
          } catch (error) {
            store.set({ busy: false, error: format(copy.failed, { message: messageOf(error) }) })
          }
        }

        /** The sidebar Session-row menu entry. */
        function SessionDeleteMenuItem(props) {
          const closeMenu = useCloseMenu(props?.useMenuOpenState)
          const onSelect = () => {
            closeMenu()
            open(String(props?.sessionId ?? ''), props?.displayTitle)
          }
          if (MenuItemButton !== null) {
            return h(
              MenuItemButton,
              {
                separatorBefore: true,
                icon: IconTrash === null ? undefined : h(IconTrash, { size: 14 }),
                onSelect,
              },
              copy.menu,
            )
          }
          return h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'dsh-sd-item dsh-sd-item-separated',
              onClick: onSelect,
            },
            copy.menu,
          )
        }

        /** The frame-wide confirmation dialog plus its toast. */
        function SessionDeleteOverlay() {
          const snapshot = useStore(store)
          const toast =
            snapshot.toast === null
              ? null
              : h('div', { className: 'dsh-sd-toast', role: 'status' }, snapshot.toast)
          if (!snapshot.open) return toast

          const preview = snapshot.preview
          const subagentCount = preview !== null && Number.isFinite(preview.subagentCount) ? preview.subagentCount : 0
          const files = preview !== null && Number.isFinite(preview.artifacts?.files) ? preview.artifacts.files : 0
          const bytes = preview !== null && Number.isFinite(preview.artifacts?.bytes) ? preview.artifacts.bytes : 0
          const sessionCount = preview !== null && Number.isFinite(preview.sessionCount) ? preview.sessionCount : 1
          const inventory =
            preview === null
              ? null
              : preview.found === false || files === 0
                ? copy.inventoryEmpty
                : format(copy.inventory, { sessions: sessionCount, files, size: formatBytes(bytes) })

          const toggleSubagents = () => {
            const next = !snapshot.includeSubagents
            store.set({ includeSubagents: next, previewing: true })
            const sessionId = snapshot.sessionId
            if (typeof sessionId !== 'string') return
            void fetchPreview(sessionId, next)
              .then((result) => {
                if (store.get().sessionId !== sessionId || store.get().includeSubagents !== next) return
                store.set({ preview: result, previewing: false })
              })
              .catch(() => store.set({ previewing: false }))
          }

          return h(
            React.Fragment,
            null,
            h(
              'div',
              {
                className: 'dsh-sd-backdrop',
                onMouseDown: (event) => {
                  if (event.target === event.currentTarget) close()
                },
              },
              h(
                'div',
                {
                  className: 'dsh-sd-panel',
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-labelledby': 'dsh-sd-title',
                  'aria-describedby': 'dsh-sd-desc',
                },
                h('h2', { className: 'dsh-sd-title', id: 'dsh-sd-title' }, copy.title),
                h('p', { className: 'dsh-sd-desc', id: 'dsh-sd-desc' }, format(copy.desc, { title: snapshot.title })),
                h('p', { className: 'dsh-sd-warning' }, copy.irreversible),
                inventory === null ? null : h('div', { className: 'dsh-sd-inventory' }, inventory),
                h(
                  'label',
                  { className: 'dsh-sd-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: snapshot.includeSubagents,
                    disabled: snapshot.busy,
                    onChange: toggleSubagents,
                  }),
                  h(
                    'span',
                    null,
                    subagentCount > 0 ? format(copy.subagents, { n: subagentCount }) : copy.subagents.replace('（{n} 个）', '').replace(' ({n})', ''),
                  ),
                ),
                snapshot.error === null ? null : h('div', { className: 'dsh-sd-error', role: 'alert' }, snapshot.error),
                snapshot.busy ? h('div', { className: 'dsh-sd-inventory', role: 'status' }, copy.working) : null,
                h(
                  'div',
                  { className: 'dsh-sd-footer' },
                  h(
                    'button',
                    { type: 'button', className: 'dsh-sd-button', disabled: snapshot.busy, onClick: close },
                    copy.cancel,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-sd-button dsh-sd-danger',
                      disabled: snapshot.busy,
                      onClick: () => {
                        void confirm()
                      },
                    },
                    snapshot.busy ? copy.working : copy.confirm,
                  ),
                ),
              ),
            ),
            toast,
          )
        }

        const installStyles = () => {
          if (document.getElementById(STYLE_ID) !== null) return () => {}
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = STYLES
          document.head.append(style)
          return () => {
            style.remove()
          }
        }

        ctx.effect(() => {
          const removeStyles = installStyles()
          const disposeMenu = ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
            ctx.slots.register(
              {
                name: 'sidebar.workspaces.session.menu.item',
                id: 'session-delete',
                // After the shipped Archive (400) and Session id (450) rows, so the
                // destructive action sits last in the menu.
                order: 500,
                inject: () => ({}),
              },
              SessionDeleteMenuItem,
            ),
          )
          const disposeOverlay = ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'session-delete.confirm',
                inject: () => ({}),
              },
              SessionDeleteOverlay,
            ),
          )
          return () => {
            if (typeof disposeMenu === 'function') disposeMenu()
            if (typeof disposeOverlay === 'function') disposeOverlay()
            store.dispose()
            removeStyles()
          }
        }, 'dsh-session-delete: slots')
      },
    }
  },
})