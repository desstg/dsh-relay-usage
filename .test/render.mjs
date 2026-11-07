/**
 * Render harness: executes the plugin's React components in Node with a minimal
 * hook runtime, so a crash in the render path surfaces with a stack trace
 * instead of a blank slot.
 */
let captured = null

globalThis.document = { documentElement: { lang: 'zh-CN' }, baseURI: 'http://127.0.0.1/' }
globalThis.location = { origin: 'http://127.0.0.1:50072' }
globalThis.navigator && Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
const store = new Map()
globalThis.window = {
  location: { origin: 'http://127.0.0.1:50072' },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  __ModuleLoader__: { load(entry) { captured = entry } },
}

let hookCursor = 0
class Component {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }
}

const ReactStub = {
  Component,
  createElement(type, props, ...children) {
    if (typeof type === 'function') {
      const saved = hookCursor
      hookCursor = 0
      try {
        if (type.prototype && typeof type.prototype.render === 'function') {
          const instance = new type({ ...(props || {}), children: children.length ? children : undefined })
          if (typeof type.getDerivedStateFromError === 'function') {
            try {
              return instance.render()
            } catch (error) {
              instance.state = type.getDerivedStateFromError(error)
              return instance.render()
            }
          }
          return instance.render()
        }
        return type({ ...(props || {}), children: children.length ? children : undefined })
      } finally {
        hookCursor = saved
      }
    }
    return { type, props: props || {}, children }
  },
  useState(initial) {
    hookCursor += 1
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() { hookCursor += 1 },
  useCallback(fn) { hookCursor += 1; return fn },
  useMemo(fn) { hookCursor += 1; return fn() },
  useRef(value) { hookCursor += 1; return { current: value } },
}

await import('../client.js')

const module = captured.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require: ${name}`)
})

const components = []
const ctx = {
  on: () => () => {},
  effect: (callback) => callback(),
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => {
      components.push({ options, component })
      return () => {}
    },
  },
}

module.apply(ctx)

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail ?? ''}`}`)
}

function render(label, options, props) {
  const entry = components.find((item) => JSON.stringify(item.options) === JSON.stringify(options))
  if (!entry) return check(`${label}: registered`, false, JSON.stringify(components.map((c) => c.options)))
  try {
    const tree = ReactStub.createElement(entry.component, props)
    check(`${label}: renders`, tree !== undefined && tree !== null, String(tree))
    return tree
  } catch (error) {
    check(`${label}: renders`, false, `${error && error.message}\n${error && error.stack}`)
    return null
  }
}

render('sidebar icon', { name: 'sidebar.panellist', id: 'relay', order: -10 }, { size: 16, active: false })
const panel = render('main panel (no session)', { name: 'main', key: 'relay' }, {})

function countText(node, needle) {
  if (node === null || node === undefined) return 0
  if (typeof node === 'string') return node.includes(needle) ? 1 : 0
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countText(item, needle), 0)
  if (typeof node !== 'object') return 0
  let hits = countText(node.children, needle)
  if (node.props) hits += countText(node.props.children, needle)
  return hits
}
const zhCopy = countText(panel, '中转站') + countText(panel, '读取中')
check('panel renders localized content', zhCopy > 0, 'tree carries no localized text')

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
