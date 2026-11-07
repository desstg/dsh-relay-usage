/**
 * Visual outline: renders the panel views with the stub hook runtime and prints
 * an indented tree, so the layout can be reviewed without a browser.
 */
let captured = null

globalThis.document = { documentElement: { lang: 'zh-CN' }, baseURI: 'http://127.0.0.1/' }
globalThis.location = { origin: 'http://127.0.0.1:50072' }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
const store = new Map()
globalThis.window = {
  location: { origin: 'http://127.0.0.1:50072' },
  addEventListener: () => {},
  removeEventListener: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
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

function outline(node, depth = 0, lines = []) {
  if (node === null || node === undefined || node === false) return lines
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node).trim()
    if (text) lines.push(`${'  '.repeat(depth)}· ${text}`)
    return lines
  }
  if (Array.isArray(node)) {
    for (const item of node) outline(item, depth, lines)
    return lines
  }
  if (typeof node !== 'object') return lines
  if (typeof node === 'object' && node.type === 'style') return lines
  if (node.type) {
    const className = node.props && node.props.className ? `.${String(node.props.className).split(' ')[0]}` : ''
    lines.push(`${'  '.repeat(depth)}<${node.type}${className}>`)
    outline(node.children, depth + 1, lines)
    if (node.props && node.props.children) outline(node.props.children, depth + 1, lines)
  }
  return lines
}

const views = module.__test || {}
if (!views.Dashboard || !views.LoginCard) {
  console.log('MISSING __test exports:', Object.keys(views))
  process.exit(1)
}

const t = (key) => (module.__test.dict[key] ?? key)

const baseStation = {
  id: 's1',
  label: 'HOHAI',
  baseUrl: 'https://api.hohai.eu.org',
  username: 'desstg',
  remember: true,
}

const overview = {
  station: { baseUrl: 'https://api.hohai.eu.org', provider: 'newapi', name: 'HOHAI', version: 'v1.0.0-rc.48', symbol: '¥', quotaPerUnit: 500000 },
  account: { id: 7, username: 'desstg', displayName: 'desstg', group: 'default' },
  wallet: { quota: 44605000, usedQuota: 83800000, balance: 89.21, usedAmount: 167.6, requestCount: 9342 },
  today: { quota: 750000, amount: 1.5, requests: 2, promptTokens: 1800, completionTokens: 1200, tokens: 3000 },
  week: {
    quota: 850000, amount: 1.7, requests: 3, tokens: 3400,
    days: [
      { key: 'a', label: '11/1', quota: 0, amount: 0, requests: 0 },
      { key: 'b', label: '11/2', quota: 100000, amount: 0.2, requests: 1 },
      { key: 'c', label: '11/3', quota: 0, amount: 0, requests: 0 },
      { key: 'd', label: '11/4', quota: 850000, amount: 1.7, requests: 3 },
      { key: 'e', label: '11/5', quota: 300000, amount: 0.6, requests: 2 },
      { key: 'f', label: '11/6', quota: 250000, amount: 0.5, requests: 1 },
      { key: 'g', label: '11/7', quota: 750000, amount: 1.5, requests: 2 },
    ],
  },
  models: [
    { name: 'deepseek-v4-pro', quota: 750000, count: 2, tokens: 3000, amount: 1.5 },
    { name: 'claude-haiku-5-5', quota: 100000, count: 1, tokens: 400, amount: 0.2 },
  ],
  logs: [
    { at: Date.now() - 60000, model: 'deepseek-v4-pro', tokens: 2000, amount: 1, useTime: 3, tokenName: '' },
    { at: Date.now() - 600000, model: 'deepseek-v4-pro', tokens: 1000, amount: 0.5, useTime: 2, tokenName: '' },
  ],
  fetchedAt: Date.now(),
}

const props = {
  overview,
  stations: [baseStation],
  activeId: 's1',
  busy: false,
  error: '',
  onRefresh: () => {},
  onAdd: () => {},
  onSignOut: () => {},
  onRemove: () => {},
  onSwitch: () => {},
  t,
}

console.log('===== 未连接（登录卡）=====')
console.log(outline(ReactStub.createElement(views.LoginCard, { t, stations: [baseStation], busy: false, error: '', onSubmit: () => {}, onCancel: () => {} })).join('\n'))
console.log('\n===== 已连接（中转站）=====')
console.log(outline(ReactStub.createElement(views.Dashboard, props)).join('\n'))
console.log('\n===== 官方站登录卡（应默认令牌方式）=====')
console.log(outline(ReactStub.createElement(views.LoginCard, {
  t,
  stations: [],
  busy: false,
  error: '',
  initialBase: 'https://platform.deepseek.com',
  onSubmit: () => {},
})).join('\n'))

console.log('\n===== 已连接（官方余额）=====')
console.log(outline(ReactStub.createElement(views.Dashboard, {
  ...props,
  overview: {
    official: true,
    note: '官方站只开放余额查询，没有公开的用量/请求明细接口。',
    station: { baseUrl: 'https://platform.deepseek.com', provider: 'deepseek', official: true, name: 'DeepSeek 官方', symbol: '¥', available: true },
    account: { username: 'DeepSeek', displayName: 'DeepSeek 官方' },
    wallet: { balance: 12.34, granted: 2.34, toppedUp: 10, currencies: [{ currency: 'CNY', total: 12.34 }] },
    today: { amount: 0, requests: 0, tokens: 0 },
    week: { days: [] },
    models: [],
    logs: [],
    fetchedAt: Date.now(),
  },
})).join('\n'))
