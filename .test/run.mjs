/**
 * Offline harness: drives the plugin's Host half against a mock new-api station.
 * Run with: node .test/run.mjs
 */
import http from 'node:http'
import { apply } from '../index.js'

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail ?? ''}`}`)
}

/* ------------------------- mock station ------------------------- */

const state = {
  accessTokens: new Set(),
  refresh: 'sid-1.secret-1',
  mode: 'jwt',
  issued: 0,
  refreshCount: 0,
  passwordOk: true,
}

function userObject() {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 7,
    username: 'desstg',
    display_name: 'desstg',
    role: 1,
    group: 'default',
    quota: 44605000,
    used_quota: 83800000,
    request_count: 9342,
    logs: [
      { created_at: now - 60, model_name: 'deepseek-v4-pro', quota: 500000, prompt_tokens: 1200, completion_tokens: 800, use_time: 3 },
      { created_at: now - 600, model_name: 'deepseek-v4-pro', quota: 250000, prompt_tokens: 600, completion_tokens: 400, use_time: 2 },
      { created_at: now - 90000, model_name: 'claude-haiku-5-5', quota: 100000, prompt_tokens: 300, completion_tokens: 100, use_time: 1 },
    ],
  }
}

const station = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, payload, headers = {}) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers })
    res.end(body)
  }
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')

  if (url.pathname === '/user/balance') {
    if (bearer !== 'sk-good') {
      return send(401, { error: { message: 'Authentication Fails', type: 'authentication_error' } })
    }
    return send(200, {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '12.34', granted_balance: '2.34', topped_up_balance: '10.00' },
      ],
    })
  }

  /* ---- DeepSeek platform (console) endpoints ---- */
  if (url.pathname === '/auth-api/v0/users/login' && req.method === 'POST') {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      if (!body.credential_id || !body.os || !body.device_id || !('area_code' in body) || !('mobile' in body) || !('email' in body)) {
        return send(200, { detail: [{ loc: 'body' }] })
      }
      // The real platform rejects a body whose identity fields are all empty.
      if (!body.mobile && !body.email) {
        return send(200, { detail: [{ loc: 'body' }] })
      }
      if (body.password !== 'good') {
        return send(200, { code: 0, msg: '', data: { biz_code: 2, biz_msg: 'PASSWORD_OR_USER_NAME_IS_WRONG', biz_data: null } })
      }
      return send(200, {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { user_token: 'tok-good', email: body.credential_id, currency: 'CNY' } },
      })
    })
    return undefined
  }

  if (url.pathname.startsWith('/auth-api/') || url.pathname.startsWith('/api/v0/')) {
    if (bearer !== 'tok-good') {
      return send(200, { code: bearer ? 40003 : 40002, msg: bearer ? 'Authorization Failed (invalid token)' : 'Missing Token', data: null })
    }
    if (url.pathname === '/auth-api/v0/users/current') {
      return send(200, { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { id: 'u1', email: 'me@example.com', currency: 'CNY' } } })
    }
    if (url.pathname === '/api/v0/users/get_user_summary') {
      return send(200, {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: {
            normal_wallets: [{ currency: 'CNY', balance: '20.2670469200000000', token_estimation: '0' }],
            bonus_wallets: [{ currency: 'CNY', balance: '0', token_estimation: '0' }],
            total_costs: [{ currency: 'CNY', amount: '1072.9225090600000000' }],
          },
        },
      })
    }
    if (url.pathname === '/api/v0/usage/amount') {
      const usage = [
        { type: 'PROMPT_TOKEN', amount: '0' },
        { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '1000' },
        { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '300' },
        { type: 'RESPONSE_TOKEN', amount: '200' },
        { type: 'REQUEST', amount: '10' },
      ]
      return send(200, {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: {
            total: [{ model: 'deepseek-flash', usage }],
            days: [{ date: '2026-11-07', data: [{ model: 'deepseek-flash', usage }] }],
          },
        },
      })
    }
    if (url.pathname === '/api/v0/usage/cost') {
      const usage = [
        { type: 'PROMPT_TOKEN', amount: '0' },
        { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '1.0' },
        { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '0.4' },
        { type: 'RESPONSE_TOKEN', amount: '0.1' },
        { type: 'REQUEST', amount: '0' },
      ]
      return send(200, {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: [{
            total: [{ model: 'deepseek-flash', usage }],
            days: [{ date: '2026-11-07', data: [{ model: 'deepseek-flash', usage }] }],
          }],
        },
      })
    }
    return send(404, { detail: 'Not Found' })
  }

  if (url.pathname === '/api/status') {
    return send(200, {
      success: true,
      data: {
        system_name: 'HOHAI',
        version: 'v1.0.0-rc.48',
        quota_per_unit: 500000,
        quota_display_type: 'CNY',
        custom_currency_symbol: '¤',
        checkin_enabled: true,
      },
    })
  }

  if (url.pathname === '/api/user/login' && req.method === 'POST') {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      if (state.mode === 'jwt') {
        if (body.username !== 'desstg' || body.password !== 'good' || !state.passwordOk) {
          return send(200, { success: false, message: 'Username or password is incorrect, or user has been banned' })
        }
        const access = `jwt-${++state.issued}`
        state.accessTokens.add(access)
        return send(200, {
          success: true,
          data: {
            access_token: access,
            token_type: 'Bearer',
            access_expires_at: Math.floor(Date.now() / 1000) + 900,
            user: userObject(),
            session: { sid: 'sid-1', current: true },
          },
        }, { 'Set-Cookie': [`new_api_refresh=${state.refresh}; Path=/api/user/auth; HttpOnly; SameSite=Strict`, 'new_api_has_session=1; Path=/'] })
      }
      // legacy one-api shape
      if (body.username !== 'legacy' || body.password !== 'good') {
        return send(200, { success: false, message: '用户名或密码错误' })
      }
      return send(200, { success: true, data: userObject() }, { 'Set-Cookie': 'session=legacycookie; Path=/; HttpOnly' })
    })
    return undefined
  }

  if (url.pathname === '/api/user/auth/refresh' && req.method === 'POST') {
    const jar = String(req.headers.cookie || '')
    if (!jar.includes(`new_api_refresh=${state.refresh}`)) {
      return send(401, { success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized, invalid refresh token' })
    }
    state.refreshCount += 1
    state.refresh = `sid-1.secret-${state.refreshCount + 1}`
    const access = `jwt-${++state.issued}`
    state.accessTokens.add(access)
    return send(200, {
      success: true,
      data: {
        access_token: access,
        token_type: 'Bearer',
        access_expires_at: Math.floor(Date.now() / 1000) + 900,
        session: { sid: 'sid-1', current: true },
      },
    }, { 'Set-Cookie': `new_api_refresh=${state.refresh}; Path=/api/user/auth; HttpOnly; SameSite=Strict` })
  }

  const authorized =
    (state.accessTokens.has(bearer) && state.mode === 'jwt') ||
    (bearer === 'pat-good' && state.mode === 'jwt') ||
    (String(req.headers.cookie || '').includes('session=legacycookie') && String(req.headers['new-api-user'] || '') === '7')

  if (url.pathname === '/api/user/self') {
    if (!authorized) return send(401, { success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized, invalid access token' })
    return send(200, { success: true, data: userObject() })
  }

  if (url.pathname === '/api/log/self') {
    if (!authorized) return send(401, { success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized, invalid access token' })
    const page = Number(url.searchParams.get('p') || 0)
    const items = page === 0 ? userObject().logs : []
    return send(200, { success: true, data: { items, total: 3, page, page_size: 100 } })
  }

  return send(404, { success: false, message: 'not found' })
})

/* ---------------------- host half under test ---------------------- */

let route = null
const ctx = {
  effect(fn) { fn() },
  webServer: { register(candidate) { route = candidate; return () => {} } },
}
apply(ctx)

const host = http.createServer((req, res) => route.handler(req, res))

function post(payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const request = http.request(
      { host: '127.0.0.1', port: host.address().port, path: '/relay-usage/api', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } },
      (response) => {
        let raw = ''
        response.on('data', (chunk) => { raw += chunk })
        response.on('end', () => {
          let json = null
          try { json = JSON.parse(raw) } catch { json = { raw } }
          resolve({ status: response.statusCode, json })
        })
      },
    )
    request.on('error', reject)
    request.end(body)
  })
}

await new Promise((resolve) => station.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${station.address().port}`

/* ---------------------------- cases ---------------------------- */

// 1. JWT login + overview
let connected = await post({ action: 'connect', baseUrl: base, username: 'desstg', password: 'good' })
check('jwt connect ok', connected.json.ok === true && connected.json.authMode === 'jwt', JSON.stringify(connected.json).slice(0, 200))
check('balance = quota / 500000', Math.abs(connected.json.overview.wallet.balance - 89.21) < 0.01, connected.json.overview?.wallet?.balance)
check('used = 167.6', Math.abs(connected.json.overview.wallet.usedAmount - 167.6) < 0.01, connected.json.overview?.wallet?.usedAmount)
check('today amount 1.50', Math.abs(connected.json.overview.today.amount - 1.5) < 0.001, connected.json.overview?.today?.amount)
check('today tokens 3000', connected.json.overview.today.tokens === 3000, connected.json.overview?.today?.tokens)
check('models ranked', connected.json.overview.models[0].name === 'deepseek-v4-pro', JSON.stringify(connected.json.overview?.models?.[0]))
check('7 day series', connected.json.overview.week.days.length === 7, connected.json.overview?.week?.days?.length)
check('logs present', connected.json.overview.logs.length === 3, connected.json.overview?.logs?.length)

const sessionId = connected.json.sessionId

// 2. expired access token is renewed transparently
state.accessTokens.clear()
let refreshed = await post({ action: 'overview', sessionId })
check('expired token auto-refreshes', refreshed.json.ok === true && state.refreshCount === 1, JSON.stringify(refreshed.json).slice(0, 200))

// 3. dead refresh session no longer signs the user out: the kept password revives it
state.accessTokens.clear()
state.refresh = 'sid-1.rotated-away'
let dead = await post({ action: 'overview', sessionId })
check('dead refresh cookie -> silent re-login', dead.json.ok === true, JSON.stringify(dead.json).slice(0, 160))

// 4. legacy cookie station
state.mode = 'legacy'
let legacy = await post({ action: 'connect', baseUrl: base, username: 'legacy', password: 'good' })
check('legacy cookie connect', legacy.json.ok === true && legacy.json.authMode === 'cookie', JSON.stringify(legacy.json).slice(0, 200))

// 5. personal access token
state.mode = 'jwt'
let pat = await post({ action: 'connect', baseUrl: base, token: 'pat-good' })
check('pat connect', pat.json.ok === true && pat.json.authMode === 'pat', JSON.stringify(pat.json).slice(0, 200))

let badPat = await post({ action: 'connect', baseUrl: base, token: 'pat-bad' })
check('bad pat rejected', badPat.json.ok === false && /令牌/.test(badPat.json.error), badPat.json.error)

// 6. station rejects the password
let badPassword = await post({ action: 'connect', baseUrl: base, username: 'desstg', password: 'wrong' })
check('wrong password surfaces station message', badPassword.json.ok === false && /incorrect/.test(badPassword.json.error), badPassword.json.error)

// 7. guards
const foreign = await post({ action: 'ping' }, { Origin: 'http://evil.example' })
check('foreign origin 403', foreign.status === 403, foreign.status)
const noPost = await new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port: host.address().port, path: '/relay-usage/api' }, (response) => resolve(response.statusCode))
})
check('GET 405', noPost === 405, noPost)
const unknown = await post({ action: 'nope' })
check('unknown action', unknown.json.ok === false && /未知操作/.test(unknown.json.error), unknown.json.error)

// 8. dead access token AND dead refresh cookie -> silent re-login with the kept password
state.mode = 'jwt'
state.passwordOk = true
const fresh = await post({ action: 'connect', baseUrl: base, username: 'desstg', password: 'good' })
state.accessTokens.clear()
state.refresh = 'sid-1.gone'
const revived = await post({ action: 'overview', sessionId: fresh.json.sessionId })
check('dead session revives via silent re-login', revived.json.ok === true, JSON.stringify(revived.json).slice(0, 200))

// 9. same, but the station now rejects the password -> needsLogin
state.accessTokens.clear()
state.refresh = 'sid-1.gone-again'
state.passwordOk = false
const gone = await post({ action: 'overview', sessionId: fresh.json.sessionId })
check('no credential left -> needsLogin', gone.json.ok === false && gone.json.needsLogin === true, JSON.stringify(gone.json))
state.passwordOk = true

// 10. official DeepSeek platform: password login -> console APIs
const official = await post({ action: 'connect', baseUrl: base, username: 'me@example.com', password: 'good', provider: 'deepseek' })
check(
  'official password login',
  official.json.ok === true && official.json.provider === 'deepseek',
  JSON.stringify(official.json).slice(0, 260),
)
check(
  'official balance from summary',
  official.json.ok === true && official.json.overview && Math.abs(official.json.overview.wallet.balance - 20.26704692) < 0.0001,
  JSON.stringify(official.json.overview && official.json.overview.wallet).slice(0, 200),
)
check(
  'official monthly usage',
  official.json.ok === true && official.json.overview && Math.abs(official.json.overview.wallet.monthlyCost - 1.5) < 0.001 && official.json.overview.wallet.monthlyTokens === 1500 && official.json.overview.wallet.monthlyRequests === 10,
  JSON.stringify(official.json.overview && official.json.overview.wallet).slice(0, 240),
)
check(
  'official model rows parsed',
  official.json.ok === true && official.json.overview && official.json.overview.models.length === 1 && official.json.overview.models[0].name === 'deepseek-flash' && official.json.overview.logs.length === 0,
  JSON.stringify(official.json.overview && official.json.overview.models),
)
check(
  'official model amount is currency',
  official.json.ok === true && Math.abs(official.json.overview.models[0].amount - 1.5) < 0.001,
  String(official.json.overview && official.json.overview.models[0] && official.json.overview.models[0].amount),
)
const officialAgain = await post({ action: 'overview', sessionId: official.json.sessionId })
check(
  'official overview refresh',
  officialAgain.json.ok === true && officialAgain.json.overview && Math.abs(officialAgain.json.overview.wallet.balance - 20.26704692) < 0.0001,
  JSON.stringify(officialAgain.json).slice(0, 200),
)
const officialToken = await post({ action: 'connect', baseUrl: base, token: 'tok-good', provider: 'deepseek' })
check('official token login', officialToken.json.ok === true, JSON.stringify(officialToken.json).slice(0, 200))
const officialBadToken = await post({ action: 'connect', baseUrl: base, token: 'tok-bad', provider: 'deepseek' })
check('official bad token -> needsLogin', officialBadToken.json.ok === false && officialBadToken.json.needsLogin === true, JSON.stringify(officialBadToken.json))
const officialBadPassword = await post({ action: 'connect', baseUrl: base, username: 'me@example.com', password: 'nope', provider: 'deepseek' })
check(
  'official wrong password surfaces platform message',
  officialBadPassword.json.ok === false && /PASSWORD_OR_USER_NAME_IS_WRONG/.test(officialBadPassword.json.error),
  officialBadPassword.json.error,
)

// identity field shape: a phone goes to mobile, anything else to email
const officialPhone = await post({ action: 'connect', baseUrl: base, username: '13800000000', password: 'good', provider: 'deepseek' })
check('official phone credential accepted', officialPhone.json.ok === true, JSON.stringify(officialPhone.json).slice(0, 200))
const officialUsername = await post({ action: 'connect', baseUrl: base, username: 'someuser', password: 'good', provider: 'deepseek' })
check('official non-email credential accepted', officialUsername.json.ok === true, JSON.stringify(officialUsername.json).slice(0, 200))

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
station.close()
host.close()
process.exit(failed.length ? 1 : 0)
