/**
 * Storage migration harness: seeds the previous build's keys and checks that the
 * panel still finds the saved stations (the regression that pinned the UI on
 * "loading" after the key bump).
 */
let captured = null

globalThis.document = { documentElement: { lang: 'zh-CN' }, baseURI: 'http://127.0.0.1/' }
globalThis.location = { origin: 'http://127.0.0.1:56662' }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

const store = new Map()
store.set('dsh.relay-usage.stations.v1', JSON.stringify([
  { id: 'a', label: 'HOHAI', baseUrl: 'https://api.hohai.eu.org', username: 'desstg', password: 'x', remember: true },
  { id: 'b', label: 'DeepSeek 官方', baseUrl: 'https://platform.deepseek.com', username: 'me@example.com', token: 'tok', remember: true },
]))
store.set('dsh.relay-usage.active.v1', JSON.stringify('b'))

globalThis.window = {
  location: { origin: 'http://127.0.0.1:56662' },
  addEventListener: () => {},
  removeEventListener: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  confirm: () => true,
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
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
          return new type({ ...(props || {}), children: children.length ? children : undefined }).render()
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

const registered = []
module.apply({
  on: () => () => {},
  effect: (callback) => callback(),
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
})

const panelEntry = registered.find((item) => item.options.key === 'relay')
const tree = ReactStub.createElement(panelEntry.component, {})

function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const item of node) texts(item, out); return out }
  if (typeof node === 'object') {
    if (node.type === 'style') return out
    texts(node.children, out)
    if (node.props) texts(node.props.children, out)
  }
  return out
}

const all = texts(tree).join(' | ')
const results = []
function check(name, condition, detail) {
  results.push(Boolean(condition))
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail ?? ''}`}`)
}

check('v2 key written back', store.has('dsh.relay-usage.stations.v2'), 'missing v2 stations')
check('active station migrated', JSON.parse(store.get('dsh.relay-usage.active.v2') || '""') === 'b', store.get('dsh.relay-usage.active.v2'))
const migrated = JSON.parse(store.get('dsh.relay-usage.stations.v2') || '[]')
check('both stations survived migration', Array.isArray(migrated) && migrated.length === 2 && migrated[1].label === 'DeepSeek 官方', JSON.stringify(migrated).slice(0, 200))
check('loading state offers an escape hatch', all.includes('添加站点'), all.slice(0, 160))

const failed = results.filter((item) => !item)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
