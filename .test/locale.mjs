/**
 * Locale harness: loads client.js with a stubbed module loader and checks the
 * sidebar label text for a given document language / browser preference.
 */
let captured = null

globalThis.document = { documentElement: { lang: '' }, baseURI: 'http://127.0.0.1/' }
globalThis.window = {
  location: { origin: 'http://127.0.0.1:50072' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: { load(entry) { captured = entry } },
}

const ReactStub = {
  Component: class { constructor(props) { this.props = props || {}; this.state = {} } },
  createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

await import('../client.js')

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail ?? ''}`}`)
}

const module = captured.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require: ${name}`)
})

function registerWith(lang, navigatorLanguage) {
  globalThis.document.documentElement.lang = lang || ''
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: navigatorLanguage || '' },
    configurable: true,
  })

  const registrations = []
  const listeners = []
  const ctx = {
    on(name, listener) {
      listeners.push({ name, listener })
      return () => {}
    },
    effect(callback) {
      return callback()
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  return { registrations, listeners }
}

const zh = registerWith('zh-CN', 'zh-CN').registrations
const zhLabel = zh.find((item) => item.options.id === 'relay')
check('html lang zh-CN -> 中转站', zhLabel && zhLabel.options.label() === '中转站', zhLabel && zhLabel.options.label())

const en = registerWith('en-US', 'en-US').registrations
const enLabel = en.find((item) => item.options.id === 'relay')
check('html lang en-US -> Relay', enLabel && enLabel.options.label() === 'Relay', enLabel && enLabel.options.label())

const browserOnly = registerWith('', 'zh-TW').registrations
check(
  'no html lang -> browser preference',
  browserOnly.some((item) => item.options.label && item.options.label() === '中转站'),
  JSON.stringify(browserOnly.map((i) => i.options.label && i.options.label())),
)

const hooked = registerWith('zh-CN', 'zh-CN')
check('locale/change hook registered', hooked.listeners.some((item) => item.name === 'locale/change'), JSON.stringify(hooked.listeners.map((i) => i.name)))

const panel = zh.find((item) => item.options.key === 'relay')
check('main panel registered on key relay', Boolean(panel), JSON.stringify(zh.map((i) => i.options)))
check('panellist order -10', zhLabel && zhLabel.options.order === -10, zhLabel && zhLabel.options.order)

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
