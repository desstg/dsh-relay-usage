/**
 * Relay station usage — Host half.
 *
 * Exposes one same-origin POST endpoint, `/relay-usage/api`, that proxies the
 * new-api / one-api relay stations a user signs in to. The browser cannot call
 * those stations directly (no permissive CORS), so every outbound request runs
 * here.
 *
 * Auth models supported, newest first:
 *   1. jwt   — new-api >= v1.0.0-rc.x: login returns `data.access_token`
 *              (a 15-minute JWT) sent as `Authorization: Bearer`; the HttpOnly
 *              `new_api_refresh` cookie (path /api/user/auth) renews it through
 *              `POST /api/user/auth/refresh`.
 *   2. cookie — older new-api / one-api: a `session` cookie plus the
 *              `New-Api-User` header.
 *   3. pat   — a personal access token pasted by the user (legacy opaque token
 *              or `nap_...`).
 *
 * Credentials live only in this process' memory: the browser keeps whatever the
 * user asked it to remember. Nothing is written to disk.
 */

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'

export const name = 'relay-usage'
export const inject = ['webServer']

const ROUTE_PATH = '/relay-usage/api'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const ACCESS_SKEW_MS = 90 * 1000
const REFRESH_COOKIE = 'new_api_refresh'

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function normalizeBase(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('请填写中转站地址')
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('中转站地址格式不正确')
  }
  if (!url.hostname) throw new Error('中转站地址格式不正确')
  return url.origin
}

function rawRequest(urlString, options) {
  const { method = 'GET', headers = {}, body, timeoutMs = 25000 } = options
  const url = new URL(urlString)
  const transport = url.protocol === 'http:' ? httpRequest : httpsRequest
  const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')

  return new Promise((resolve, reject) => {
    const req = transport(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Encoding': 'identity',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求中转站超时'))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function requestJson(urlString, options = {}) {
  let response
  try {
    response = await rawRequest(urlString, options)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    throw new Error(`无法连接中转站：${message}`)
  }
  let json = null
  if (response.text) {
    try {
      json = JSON.parse(response.text)
    } catch {
      json = null
    }
  }
  return { status: response.status, headers: response.headers, json, text: response.text }
}

/* --------------------------- cookie helpers ------------------------- */

function readSetCookies(headers) {
  const raw = headers['set-cookie']
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

/** Merge one response's Set-Cookie headers into a `name -> value` map. */
function mergeCookies(jar, headers) {
  const next = { ...jar }
  for (const line of readSetCookies(headers)) {
    const pair = String(line).split(';')[0]
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!name) continue
    if (!value) delete next[name]
    else next[name] = value
  }
  return next
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function apiMessage(json, fallback) {
  if (!json || typeof json !== 'object') return fallback
  const candidate =
    json.message_key ||
    (json.error && (json.error.message || json.error.type)) ||
    json.message
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  return fallback
}

class AuthExpired extends Error {
  constructor(message) {
    super(message)
    this.needsLogin = true
  }
}

/* ------------------------------------------------------------------ *
 * Station calls
 * ------------------------------------------------------------------ */

function stationHeaders(session, extra) {
  const headers = { ...extra }
  if (session.mode === 'jwt') {
    if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`
  } else if (session.mode === 'pat') {
    headers.Authorization = `Bearer ${session.pat}`
  } else {
    const cookie = cookieHeader(session.cookies)
    if (cookie) headers.Cookie = cookie
    if (session.userId !== undefined && session.userId !== null && session.userId !== '') {
      headers['New-Api-User'] = String(session.userId)
    }
  }
  return headers
}

async function stationGet(session, path) {
  return requestJson(`${session.baseUrl}${path}`, { headers: stationHeaders(session) })
}

async function refreshAccess(session) {
  const cookie = session.cookies[REFRESH_COOKIE]
  if (!cookie) throw new AuthExpired('登录状态已过期，请重新登录')

  const base = { Cookie: `${REFRESH_COOKIE}=${cookie}` }
  // The station guards refresh with an Origin check only in secure-cookie mode;
  // try its own origin first, then a Referer-only form, then no session header.
  const strategies = [
    { ...base, Origin: session.baseUrl },
    { ...base, Referer: `${session.baseUrl}/` },
  ]

  let lastMessage = ''
  for (const strategy of strategies) {
    for (const withSid of session.sid ? [true, false] : [false]) {
      const headers = { ...strategy }
      if (withSid) headers['X-Auth-Session'] = session.sid

      let result
      try {
        result = await requestJson(`${session.baseUrl}/api/user/auth/refresh`, { method: 'POST', headers })
      } catch {
        continue
      }
      const data = result.json && result.json.data ? result.json.data : null
      if (data && data.access_token) {
        session.cookies = mergeCookies(session.cookies, result.headers)
        session.accessToken = String(data.access_token)
        session.accessExpiresAt = Number(data.access_expires_at) || 0
        if (data.session && data.session.sid) session.sid = String(data.session.sid)
        return session
      }
      lastMessage = apiMessage(result.json, lastMessage)
      if (result.status !== 409 && result.status !== 403) break
    }
  }
  throw new AuthExpired(lastMessage || '登录状态已过期，请重新登录')
}

/** Re-run the password login kept in memory, without asking the user again. */
async function silentRelogin(session) {
  if (!session.password || !session.username) return false
  let logged
  try {
    logged = await loginWithPassword(session.baseUrl, session.username, session.password)
  } catch {
    return false
  }
  session.mode = logged.mode
  session.accessToken = logged.accessToken
  session.accessExpiresAt = logged.accessExpiresAt
  session.cookies = logged.cookies ?? {}
  session.sid = logged.sid ?? ''
  session.pat = logged.pat
  if (logged.userId !== undefined) session.userId = logged.userId
  return true
}

async function ensureAccess(session) {
  if (session.mode !== 'jwt') return session
  const expiresAt = Number(session.accessExpiresAt) || 0
  const stale = !session.accessToken || (expiresAt > 0 && Date.now() + ACCESS_SKEW_MS >= expiresAt * 1000)
  if (stale) await refreshAccess(session)
  return session
}

/** Authenticated GET with one transparent refresh attempt on 401. */
async function authedGet(session, path) {
  await ensureAccess(session)
  let result = await stationGet(session, path)
  if (result.status === 401 && session.mode === 'jwt' && session.cookies[REFRESH_COOKIE]) {
    await refreshAccess(session)
    result = await stationGet(session, path)
  }
  return result
}

async function getStatus(baseUrl) {
  try {
    const result = await requestJson(`${baseUrl}/api/status`)
    if (result.json && result.json.data) return result.json.data
  } catch {
    /* the station stays usable without its public metadata */
  }
  return {}
}

async function getSelf(session) {
  let result
  try {
    result = await authedGet(session, '/api/user/self')
  } catch (error) {
    if (error && error.needsLogin && (await silentRelogin(session))) {
      result = await authedGet(session, '/api/user/self')
    } else {
      throw error
    }
  }
  if ((result.status === 401 || result.status === 403) && (await silentRelogin(session))) {
    result = await authedGet(session, '/api/user/self')
  }
  if (result.status === 401 || result.status === 403) {
    return {
      unauthorized: true,
      message: apiMessage(result.json, '登录状态已失效，请重新登录'),
    }
  }
  if (!result.json || result.json.success === false) {
    return { unauthorized: false, message: apiMessage(result.json, '读取账户信息失败') }
  }
  return { user: result.json.data ?? null }
}

async function getLogs(session, { startTimestamp, endTimestamp, maxPages = 8 }) {
  const items = []
  let total
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ p: String(page), page_size: '100', type: '2' })
    if (startTimestamp) query.set('start_timestamp', String(startTimestamp))
    if (endTimestamp) query.set('end_timestamp', String(endTimestamp))

    let result
    try {
      result = await authedGet(session, `/api/log/self?${query.toString()}`)
    } catch {
      break
    }
    if (!result.json || result.json.success === false) break

    const data = result.json.data
    const list = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : []
    if (typeof data?.total === 'number') total = data.total
    items.push(...list)
    if (list.length < 100) break
    if (typeof total === 'number' && items.length >= total) break
  }
  return items
}

/* ------------------------------------------------------------------ *
 * Providers
 *
 * new-api / one-api          — account login, quota + usage logs.
 * deepseek (official)        — API key only, GET /user/balance (balance has
 *                              no public usage/history endpoint, and
 *                              platform.deepseek.com answers 429 to scripts).
 * ------------------------------------------------------------------ */

function hostOfUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function detectProvider(baseUrl, requested) {
  const wanted = String(requested ?? '').trim().toLowerCase()
  if (wanted === 'deepseek' || wanted === 'newapi') return wanted
  const host = hostOfUrl(baseUrl)
  if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek'
  return 'newapi'
}

/** The console host is not an API host; the console is where these APIs live. */
function apiBaseFor(baseUrl, provider) {
  if (provider !== 'deepseek') return baseUrl
  const host = hostOfUrl(baseUrl)
  if (host === 'api.deepseek.com' || host === 'deepseek.com' || host === 'www.deepseek.com') {
    return 'https://platform.deepseek.com'
  }
  return baseUrl
}

const OFFICIAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

function officialHeaders(token, apiBase) {
  return {
    Authorization: `Bearer ${token}`,
    Referer: `${apiBase}/usage`,
    Origin: apiBase,
    Accept: 'application/json, text/plain, */*',
  }
}

/** Unwraps the platform envelope: { code, msg, data: { biz_code, biz_msg, biz_data } }. */
function unwrapOfficial(json) {
  if (!json || typeof json !== 'object') return { ok: false, message: '官方接口返回无法解析的响应' }
  if (Array.isArray(json.detail)) {
    // FastAPI validation failure: name the offending location instead of a vague error.
    const where = json.detail
      .map((item) => (item && item.loc ? String(item.loc) : ''))
      .filter(Boolean)
      .join(', ')
    return { ok: false, message: `平台拒绝了请求参数（${where || 'body'}）` }
  }
  if (json.detail) return { ok: false, message: `平台拒绝了请求参数：${String(json.detail)}` }
  if (typeof json.code === 'number' && json.code !== 0) {
    return {
      ok: false,
      auth: json.code === 40002 || json.code === 40003,
      message: json.msg || `平台错误 ${json.code}`,
    }
  }
  const payload = json.data
  if (payload && typeof payload === 'object' && typeof payload.biz_code === 'number' && payload.biz_code !== 0) {
    return { ok: false, message: payload.biz_msg || `平台错误 ${payload.biz_code}` }
  }
  const value = payload && typeof payload === 'object' && 'biz_data' in payload ? payload.biz_data : payload
  return { ok: true, value }
}

/** Finds a session token in a login response without trusting one exact shape. */
function findOfficialToken(root) {
  const preferred = [
    ['data', 'biz_data', 'user_token'],
    ['data', 'biz_data', 'token'],
    ['data', 'biz_data', 'access_token'],
    ['data', 'biz_data', 'userToken'],
    ['data', 'user_token'],
    ['data', 'token'],
    ['data', 'access_token'],
    ['user_token'],
    ['token'],
  ]
  for (const path of preferred) {
    let node = root
    for (const key of path) {
      if (!node || typeof node !== 'object') {
        node = undefined
        break
      }
      node = node[key]
    }
    if (typeof node === 'string' && node.trim().length > 0) return { token: node.trim(), path: path.join('.') }
  }
  const seen = []
  const walk = (node, path, depth) => {
    if (!node || typeof node !== 'object' || depth > 4) return null
    for (const [key, value] of Object.entries(node)) {
      const next = path ? `${path}.${key}` : key
      if (typeof value === 'string' && /token/i.test(key) && value.length >= 16) {
        return { token: value, path: next }
      }
      if (value && typeof value === 'object') {
        const found = walk(value, next, depth + 1)
        if (found) return found
      }
      seen.push(next)
    }
    return null
  }
  const found = walk(root, '', 0)
  return found ?? { token: '', path: '', keys: seen.slice(0, 40) }
}

/**
 * The platform rejects a body whose identity fields are all empty (it answers
 * `{"detail":[{"loc":"body"}]}`). A phone number belongs in `mobile`, anything
 * else is accepted in `email`, so exactly one identity field is ever filled.
 */
function officialLoginBody(credential, password) {
  const trimmed = String(credential ?? '').trim()
  const compact = trimmed.replace(/[\s-]/g, '')
  const isPhone = /^\+?\d{6,}$/.test(compact)
  const phone = compact.replace(/^\+?86/, '')
  return {
    credential_id: trimmed,
    os: 'web',
    device_id: `dsh-${randomBytes(8).toString('hex')}`,
    area_code: isPhone ? '+86' : '',
    password,
    mobile: isPhone ? phone : '',
    email: isPhone ? '' : trimmed,
  }
}

async function officialLogin(apiBase, credential, password) {
  const body = officialLoginBody(credential, password)
  const result = await requestJson(`${apiBase}/auth-api/v0/users/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: `${apiBase}/`,
      Origin: apiBase,
    },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  })
  const unwrapped = unwrapOfficial(result.json)
  if (!unwrapped.ok) {
    const error = new Error(unwrapped.message)
    if (unwrapped.auth) error.needsLogin = true
    throw error
  }
  const found = findOfficialToken(result.json)
  if (!found.token) {
    throw new Error(`登录成功但没找到会话令牌（响应字段：${(found.keys || []).join(', ') || '空'}）`)
  }
  const payload = unwrapped.value && typeof unwrapped.value === 'object' ? unwrapped.value : {}
  return {
    token: found.token,
    email: typeof payload.email === 'string' ? payload.email : credential,
    currency: typeof payload.currency === 'string' ? payload.currency : 'CNY',
  }
}

function pickNumber(source, pattern) {
  if (!source || typeof source !== 'object') return undefined
  for (const [key, value] of Object.entries(source)) {
    if (!pattern.test(key)) continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return undefined
}

async function officialGet(apiBase, token, path) {
  const result = await requestJson(`${apiBase}${path}`, { headers: officialHeaders(token, apiBase) })
  const unwrapped = unwrapOfficial(result.json)
  if (!unwrapped.ok) {
    const error = new Error(unwrapped.message)
    if (unwrapped.auth) error.needsLogin = true
    throw error
  }
  return unwrapped.value
}

/** Last official payload, kept for on-disk diagnosis through the `official-raw` action. */
let lastOfficialDebug = null

async function officialSnapshot(apiBase, token) {
  const now = new Date()
  const month = now.getMonth() + 1
  const year = now.getFullYear()

  const [current, summary, amount, cost] = await Promise.all([
    officialGet(apiBase, token, '/auth-api/v0/users/current').catch((error) => ({ __error: String(error && error.message) })),
    officialGet(apiBase, token, '/api/v0/users/get_user_summary').catch((error) => ({ __error: String(error && error.message) })),
    officialGet(apiBase, token, `/api/v0/usage/amount?month=${month}&year=${year}`).catch((error) => ({ __error: String(error && error.message) })),
    officialGet(apiBase, token, `/api/v0/usage/cost?month=${month}&year=${year}`).catch((error) => ({ __error: String(error && error.message) })),
  ])

  lastOfficialDebug = { at: Date.now(), apiBase, month, year, raw: { current, summary, amount, cost } }

  const usable = [current, summary, amount, cost].filter(
    (node) => node && typeof node === 'object' && !node.__error,
  )
  if (!usable.length) {
    const firstError = [current, summary, amount, cost].find((node) => node && node.__error)
    const error = new Error(firstError ? firstError.__error : '官方接口全部不可用，请确认令牌是否有效')
    error.needsLogin = true
    throw error
  }

  const summaryNode = summary && typeof summary === 'object' ? summary : {}
  const amountNode = amount && typeof amount === 'object' ? amount : {}
  /* `usage/cost` answers with a one-element array of { total, days }; `usage/amount` with the object itself. */
  const costNode = Array.isArray(cost) ? (cost[0] ?? {}) : cost && typeof cost === 'object' ? cost : {}
  const currentNode = current && typeof current === 'object' ? current : {}

  const normalWallets = Array.isArray(summaryNode.normal_wallets) ? summaryNode.normal_wallets : []
  const bonusWallets = Array.isArray(summaryNode.bonus_wallets) ? summaryNode.bonus_wallets : []
  const totalCosts = Array.isArray(summaryNode.total_costs) ? summaryNode.total_costs : []

  const balance = normalWallets.reduce((sum, wallet) => sum + (Number(wallet.balance) || 0), 0)
  const bonusBalance = bonusWallets.reduce((sum, wallet) => sum + (Number(wallet.balance) || 0), 0)
  const usedAmount = totalCosts.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)

  const amountTotal = Array.isArray(amountNode.total) ? amountNode.total : []
  const costTotal = Array.isArray(costNode.total) ? costNode.total : []
  const amountDays = Array.isArray(amountNode.days) ? amountNode.days : []
  const costDays = Array.isArray(costNode.days) ? costNode.days : []

  const monthlyTokens = amountTotal.reduce((sum, row) => sum + officialTokens(row.usage), 0)
  const monthlyRequests = amountTotal.reduce((sum, row) => sum + officialRequests(row.usage), 0)
  const monthlyCost = costTotal.reduce((sum, row) => sum + officialMoney(row.usage), 0)

  const costByModel = new Map(costTotal.map((row) => [row.model, officialMoney(row.usage)]))
  const models = amountTotal
    .map((row) => ({
      name: row.model || '未知模型',
      tokens: officialTokens(row.usage),
      count: officialRequests(row.usage),
      amount: costByModel.get(row.model) ?? officialMoney(row.usage),
    }))
    .sort((left, right) => right.tokens - left.tokens)

  const costByDate = new Map()
  for (const entry of costDays) {
    const total = (entry.data || []).reduce((sum, row) => sum + officialMoney(row.usage), 0)
    costByDate.set(entry.date, total)
  }

  const pad = (value) => String(value).padStart(2, '0')
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

  const dayList = amountDays.map((entry) => {
    const rows = entry.data || []
    const tokens = rows.reduce((sum, row) => sum + officialTokens(row.usage), 0)
    const requests = rows.reduce((sum, row) => sum + officialRequests(row.usage), 0)
    return {
      key: entry.date,
      date: entry.date,
      label: String(entry.date || '').slice(5).replace('-', '/'),
      quota: tokens,
      tokens,
      requests,
      amount: costByDate.get(entry.date) ?? 0,
    }
  })

  const recentDays = dayList.filter((day) => day.date && day.date <= todayKey).slice(-7)
  const todayRow = dayList.find((day) => day.date === todayKey)

  const identity = currentNode.id_profile && typeof currentNode.id_profile === 'object' ? currentNode.id_profile : {}

  return {
    currency: typeof currentNode.currency === 'string' && currentNode.currency ? currentNode.currency : 'CNY',
    email: (typeof currentNode.email === 'string' && currentNode.email) || '',
    mobile: (typeof currentNode.mobile_number === 'string' && currentNode.mobile_number) || '',
    displayName:
      (typeof identity.name === 'string' && identity.name) ||
      (typeof currentNode.mobile_number === 'string' && currentNode.mobile_number) ||
      '',
    balance,
    bonusBalance,
    usedAmount,
    monthlyCost,
    monthlyTokens,
    monthlyRequests,
    today: todayRow
      ? { amount: todayRow.amount, tokens: todayRow.tokens, requests: todayRow.requests }
      : { amount: 0, tokens: 0, requests: 0 },
    days: recentDays,
    models,
    raw: { current, summary, amount, cost },
  }
}

/** Token-ish usage entries on the platform: prompt, cache hit, cache miss, response. */
const OFFICIAL_TOKEN_TYPES = new Set([
  'PROMPT_TOKEN',
  'PROMPT_CACHE_HIT_TOKEN',
  'PROMPT_CACHE_MISS_TOKEN',
  'RESPONSE_TOKEN',
])

function officialSum(usage, accept) {
  let total = 0
  for (const item of usage || []) {
    if (!item || !accept(String(item.type || '').toUpperCase())) continue
    const value = Number(item.amount)
    if (Number.isFinite(value)) total += value
  }
  return total
}

function officialTokens(usage) {
  return officialSum(usage, (type) => OFFICIAL_TOKEN_TYPES.has(type))
}

function officialRequests(usage) {
  return officialSum(usage, (type) => type === 'REQUEST')
}

function officialMoney(usage) {
  return officialSum(usage, (type) => type !== 'REQUEST')
}

async function fetchOfficialBalance(apiBase, key) {
  const result = await requestJson(`${apiBase}/user/balance`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (result.status === 401 || result.status === 403) {
    const error = new Error(apiMessage(result.json, 'API Key 无效或已停用'))
    error.needsLogin = true
    throw error
  }
  if (!result.json) throw new Error(`官方接口返回无法解析的响应（HTTP ${result.status}）`)
  return result.json
}

function officialOverview(session, snapshot) {
  const symbol = String(snapshot.currency || 'CNY').toUpperCase() === 'USD' ? '$' : '¥'
  const days = Array.isArray(snapshot.days) ? snapshot.days : []
  const today = snapshot.today || { amount: 0, tokens: 0, requests: 0 }
  const totalTokens = days.reduce((sum, day) => sum + (Number(day.tokens) || 0), 0)
  const totalAmount = days.reduce((sum, day) => sum + (Number(day.amount) || 0), 0)
  const totalRequests = days.reduce((sum, day) => sum + (Number(day.requests) || 0), 0)

  return {
    official: true,
    note: '官方站数据来自平台接口：余额、本月消费、Token 与请求数，按天和按模型汇总；没有逐条请求日志。',
    station: {
      baseUrl: session.baseUrl,
      provider: 'deepseek',
      official: true,
      name: 'DeepSeek 官方',
      version: '',
      symbol,
      currency: String(snapshot.currency || 'CNY'),
      quotaPerUnit: 0,
      available: true,
    },
    account: {
      id: null,
      username: snapshot.mobile || snapshot.email || 'DeepSeek',
      displayName: snapshot.displayName || 'DeepSeek 官方',
      group: '',
      role: 0,
    },
    wallet: {
      quota: 0,
      usedQuota: 0,
      balance: numberOrZero(snapshot.balance),
      usedAmount: numberOrZero(snapshot.usedAmount),
      requestCount: numberOrZero(snapshot.monthlyRequests),
      bonus: numberOrZero(snapshot.bonusBalance),
      monthlyCost: snapshot.monthlyCost === undefined ? undefined : numberOrZero(snapshot.monthlyCost),
      monthlyTokens: snapshot.monthlyTokens === undefined ? undefined : numberOrZero(snapshot.monthlyTokens),
      monthlyRequests: snapshot.monthlyRequests === undefined ? undefined : numberOrZero(snapshot.monthlyRequests),
    },
    today: {
      quota: numberOrZero(today.tokens),
      amount: numberOrZero(today.amount),
      requests: numberOrZero(today.requests),
      promptTokens: 0,
      completionTokens: 0,
      tokens: numberOrZero(today.tokens),
    },
    week: {
      quota: totalTokens,
      amount: totalAmount,
      requests: totalRequests,
      tokens: totalTokens,
      days,
    },
    models: Array.isArray(snapshot.models) ? snapshot.models : [],
    logs: [],
    raw: snapshot.raw,
    fetchedAt: Date.now(),
  }
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

function pad2(value) {
  return String(value).padStart(2, '0')
}

function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function startOfDay(time) {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function numberOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function summarizeLogs(items, quotaPerUnit) {
  const now = Date.now()
  const todayStart = startOfDay(now)
  const todayEnd = todayStart + DAY_MS
  const weekStart = todayStart - 6 * DAY_MS

  const dayBuckets = new Map()
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(todayStart + offset * DAY_MS)
    dayBuckets.set(dayKeyOf(date), {
      key: dayKeyOf(date),
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      quota: 0,
      requests: 0,
      tokens: 0,
    })
  }

  const modelBuckets = new Map()
  const today = { quota: 0, requests: 0, promptTokens: 0, completionTokens: 0 }
  const week = { quota: 0, requests: 0, tokens: 0 }
  const recent = []

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const createdSeconds = numberOrZero(item.created_at)
    if (!createdSeconds) continue
    const createdMs = createdSeconds * 1000
    if (createdMs < weekStart - DAY_MS) continue

    const quota = numberOrZero(item.quota)
    const promptTokens = numberOrZero(item.prompt_tokens)
    const completionTokens = numberOrZero(item.completion_tokens)
    const tokens = promptTokens + completionTokens
    const modelName =
      typeof item.model_name === 'string' && item.model_name ? item.model_name : '未知模型'

    recent.push({
      at: createdMs,
      model: modelName,
      quota,
      amount: quotaPerUnit ? quota / quotaPerUnit : 0,
      tokens,
      useTime: numberOrZero(item.use_time),
      tokenName: typeof item.token_name === 'string' ? item.token_name : '',
    })

    const bucket = dayBuckets.get(dayKeyOf(new Date(createdMs)))
    if (bucket) {
      bucket.quota += quota
      bucket.requests += 1
      bucket.tokens += tokens
    }

    const model = modelBuckets.get(modelName) ?? { name: modelName, quota: 0, count: 0, tokens: 0 }
    model.quota += quota
    model.count += 1
    model.tokens += tokens
    modelBuckets.set(modelName, model)

    if (createdMs >= todayStart && createdMs < todayEnd) {
      today.quota += quota
      today.requests += 1
      today.promptTokens += promptTokens
      today.completionTokens += completionTokens
    }

    week.quota += quota
    week.requests += 1
    week.tokens += tokens
  }

  recent.sort((left, right) => right.at - left.at)

  const convert = (quota) => (quotaPerUnit ? quota / quotaPerUnit : 0)
  const days = [...dayBuckets.values()].map((day) => ({ ...day, amount: convert(day.quota) }))
  const models = [...modelBuckets.values()]
    .map((model) => ({ ...model, amount: convert(model.quota) }))
    .sort((left, right) => right.quota - left.quota)
    .slice(0, 8)

  return {
    today: {
      quota: today.quota,
      amount: convert(today.quota),
      requests: today.requests,
      promptTokens: today.promptTokens,
      completionTokens: today.completionTokens,
      tokens: today.promptTokens + today.completionTokens,
    },
    week: {
      quota: week.quota,
      amount: convert(week.quota),
      requests: week.requests,
      tokens: week.tokens,
      days,
    },
    models,
    logs: recent.slice(0, 40),
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function pruneSessions(sessions) {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, session] of sessions) {
    if (session.touchedAt < cutoff) sessions.delete(id)
  }
}

function newSessionId() {
  return randomBytes(16).toString('hex')
}

async function loginWithPassword(baseUrl, username, password) {
  if (!username) throw new Error('请填写用户名')
  if (!password) throw new Error('请填写密码')

  const result = await requestJson(`${baseUrl}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ username, password }),
  })

  if (!result.json) throw new Error(`中转站返回了无法解析的响应（HTTP ${result.status}）`)
  if (result.json.success === false) throw new Error(apiMessage(result.json, '用户名或密码不正确'))

  const data = result.json.data ?? {}
  const cookies = mergeCookies({}, result.headers)

  // new-api >= v1.0.0-rc.x: a short-lived JWT access token plus a refresh cookie.
  if (data.access_token) {
    return {
      mode: 'jwt',
      accessToken: String(data.access_token),
      accessExpiresAt: Number(data.access_expires_at) || 0,
      cookies,
      sid: data.session && data.session.sid ? String(data.session.sid) : '',
      userId: data.user && data.user.id !== undefined ? data.user.id : undefined,
      user: data.user ?? null,
    }
  }

  // Older new-api / one-api: cookie session plus the New-Api-User header.
  const legacyUser = data && typeof data === 'object' && data.id !== undefined ? data : null
  const hasSessionCookie = Object.keys(cookies).length > 0
  if (!hasSessionCookie && !legacyUser) {
    throw new Error('登录成功但站点没有返回可用的凭证（既无 access_token，也无会话 Cookie）')
  }
  return {
    mode: 'cookie',
    cookies,
    sid: '',
    userId: legacyUser ? legacyUser.id : undefined,
    user: legacyUser,
  }
}

async function connectStation(input) {
  const baseUrl = normalizeBase(input.baseUrl)
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  const rawUserId = String(input.userId ?? '').trim()
  const provider = detectProvider(baseUrl, input.provider)

  if (provider === 'deepseek') {
    const apiBase = apiBaseFor(baseUrl, provider)
    const username = String(input.username ?? '').trim()
    const password = String(input.password ?? '')
    let sessionToken = token

    if (!sessionToken) {
      if (!username || !password) {
        throw new Error('请填写 DeepSeek 账号（邮箱或手机号）与密码，或粘贴平台令牌')
      }
      const loggedIn = await officialLogin(apiBase, username, password)
      sessionToken = loggedIn.token
    }

    let snapshot
    try {
      snapshot = await officialSnapshot(apiBase, sessionToken)
    } catch (error) {
      // A plain API key cannot read the console APIs; fall back to /user/balance.
      if (sessionToken.startsWith('sk-') || token) {
        const balance = await fetchOfficialBalance('https://api.deepseek.com', sessionToken)
        snapshot = {
          currency: (balance.balance_infos && balance.balance_infos[0] && balance.balance_infos[0].currency) || 'CNY',
          email: username,
          balance: numberOrZero(balance.balance_infos && balance.balance_infos[0] && balance.balance_infos[0].total_balance),
          usedAmount: undefined,
          monthlyCost: undefined,
          monthlyTokens: undefined,
          raw: balance,
        }
      } else {
        throw error
      }
    }

    const session = {
      mode: 'pat',
      pat: sessionToken,
      provider,
      apiBase,
      cookies: {},
      username,
      password,
    }
    const overview = officialOverview({ baseUrl, ...session }, snapshot)
    return {
      baseUrl,
      provider,
      account: overview.account,
      session,
      meta: overview.station,
      authMode: 'pat',
      overview,
    }
  }

  let session
  if (token) {
    session = { mode: 'pat', pat: token, cookies: {}, userId: rawUserId || undefined }
  } else {
    const username = String(input.username ?? '').trim()
    const password = String(input.password ?? '')
    const loggedIn = await loginWithPassword(baseUrl, username, password)
    // Kept in host memory only, so an expired access token can be renewed
    // without asking the user to sign in again.
    session = { ...loggedIn, username, password }
  }

  const authSession = { baseUrl, ...session }
  const self = await getSelf(authSession)
  if (self.unauthorized) {
    throw new Error(
      session.mode === 'pat'
        ? '访问令牌无效或权限不足（该站点要求 nap_ 开头的新版令牌，或该令牌没有读取个人信息的 scope）'
        : '登录成功，但站点拒绝读取账户信息：请稍后重试，或改用访问令牌登录',
    )
  }
  if (!self.user && self.message) throw new Error(self.message)

  const user = self.user ?? session.user ?? {}
  const status = await getStatus(baseUrl)

  return {
    baseUrl,
    provider: 'newapi',
    account: {
      id: user.id !== undefined ? user.id : session.userId,
      username: user.username ?? '',
      displayName: user.display_name || user.username || '',
      role: numberOrZero(user.role),
      group: typeof user.group === 'string' ? user.group : '',
      email: typeof user.email === 'string' ? user.email : '',
    },
    session: { ...authSession, provider: 'newapi', apiBase: baseUrl },
    meta: {
      provider: 'newapi',
      name: typeof status.system_name === 'string' ? status.system_name : '',
      version: typeof status.version === 'string' ? status.version : '',
      quotaPerUnit: numberOrZero(status.quota_per_unit) || 500000,
      symbol:
        typeof status.custom_currency_symbol === 'string' && status.custom_currency_symbol !== '¤'
          ? status.custom_currency_symbol
          : status.quota_display_type === 'USD'
            ? '$'
            : '¥',
      currency: typeof status.quota_display_type === 'string' ? status.quota_display_type : 'CNY',
      checkinEnabled: status.checkin_enabled === true,
    },
    authMode: session.mode,
  }
}

async function buildOverview(session) {
  if (session.provider === 'deepseek') {
    try {
      const snapshot = await officialSnapshot(session.apiBase || 'https://platform.deepseek.com', session.pat)
      return officialOverview(session, snapshot)
    } catch (error) {
      if (session.pat && session.pat.startsWith('sk-')) {
        const balance = await fetchOfficialBalance('https://api.deepseek.com', session.pat)
        const first = (balance.balance_infos && balance.balance_infos[0]) || {}
        return officialOverview(session, {
          currency: first.currency || 'CNY',
          email: session.username,
          balance: numberOrZero(first.total_balance),
          raw: balance,
        })
      }
      throw error
    }
  }

  const self = await getSelf(session)
  if (self.unauthorized) {
    throw new AuthExpired(self.message || '登录状态已失效，请重新登录')
  }
  if (!self.user && self.message) throw new Error(self.message)

  const user = self.user ?? {}
  const quotaPerUnit = session.meta.quotaPerUnit || 500000
  const now = Date.now()
  const todayStart = startOfDay(now)
  const weekStart = todayStart - 6 * DAY_MS

  const logs = await getLogs(session, {
    startTimestamp: Math.floor(weekStart / 1000),
    endTimestamp: Math.floor((todayStart + DAY_MS) / 1000),
  })
  const summary = summarizeLogs(logs, quotaPerUnit)

  const quota = numberOrZero(user.quota)
  const usedQuota = numberOrZero(user.used_quota)

  return {
    station: { baseUrl: session.baseUrl, ...session.meta },
    account: {
      id: user.id,
      username: user.username ?? session.account?.username ?? '',
      displayName: user.display_name || user.username || session.account?.displayName || '',
      group: typeof user.group === 'string' ? user.group : '',
      role: numberOrZero(user.role),
    },
    wallet: {
      quota,
      usedQuota,
      balance: quotaPerUnit ? quota / quotaPerUnit : 0,
      usedAmount: quotaPerUnit ? usedQuota / quotaPerUnit : 0,
      requestCount: numberOrZero(user.request_count),
    },
    ...summary,
    fetchedAt: Date.now(),
  }
}

/* ------------------------------------------------------------------ *
 * Route
 * ------------------------------------------------------------------ */

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

export function apply(ctx) {
  /** @type {Map<string, any>} */
  const sessions = new Map()
  const clientErrors = []

  async function handleAction(payload) {
    const action = typeof payload.action === 'string' ? payload.action : ''

    if (action === 'client-error') {
      clientErrors.push({
        at: Date.now(),
        where: String(payload.where ?? ''),
        message: String(payload.message ?? ''),
        stack: String(payload.stack ?? '').slice(0, 4000),
      })
      if (clientErrors.length > 20) clientErrors.shift()
      return { ok: true }
    }

    if (action === 'client-log') {
      return { ok: true, errors: clientErrors }
    }

    if (action === 'official-raw') {
      return { ok: true, last: lastOfficialDebug }
    }

    if (action === 'connect') {
      pruneSessions(sessions)
      const connected = await connectStation(payload)
      const id = newSessionId()
      const session = {
        id,
        baseUrl: connected.baseUrl,
        provider: connected.provider ?? 'newapi',
        apiBase: connected.session.apiBase ?? connected.baseUrl,
        mode: connected.session.mode,
        accessToken: connected.session.accessToken,
        accessExpiresAt: connected.session.accessExpiresAt,
        cookies: connected.session.cookies ?? {},
        sid: connected.session.sid ?? '',
        pat: connected.session.pat,
        userId: connected.session.userId,
        username: connected.session.username,
        password: connected.session.password,
        account: connected.account,
        meta: connected.meta,
        touchedAt: Date.now(),
      }
      sessions.set(id, session)
      const overview = connected.overview ?? (await buildOverview(session))
      return {
        ok: true,
        sessionId: id,
        authMode: connected.authMode,
        provider: session.provider,
        station: overview.station,
        account: overview.account,
        overview,
      }
    }

    if (action === 'overview') {
      const session = sessions.get(String(payload.sessionId ?? ''))
      if (!session) return { ok: false, needsLogin: true, error: '会话已过期，请重新登录' }
      session.touchedAt = Date.now()
      const overview = await buildOverview(session)
      return { ok: true, overview }
    }

    if (action === 'ping') {
      return { ok: true, version: '1.5.1' }
    }

    if (action === 'logout') {
      sessions.delete(String(payload.sessionId ?? ''))
      return { ok: true }
    }

    return { ok: false, error: `未知操作：${action || '(空)'}` }
  }

  ctx.effect(() => {
    function isLoopback(address) {
      const text = String(address ?? '')
      return text === '127.0.0.1' || text === '::1' || text === '::ffff:127.0.0.1' || text.startsWith('127.')
    }

    function sameOrigin(request) {
      const requestOrigin = request.headers.origin
      if (!requestOrigin) return true
      try {
        return new URL(requestOrigin).host === request.headers.host
      } catch {
        return false
      }
    }

    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      async handler(request, response) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: '仅支持 POST' })
          return
        }
        if (!isLoopback(request.socket && request.socket.remoteAddress)) {
          sendJson(response, 403, { ok: false, error: '仅允许本机访问' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, error: '来源不匹配' })
          return
        }

        let result
        try {
          const payload = await readJsonBody(request)
          result = await handleAction(payload ?? {})
        } catch (error) {
          result = {
            ok: false,
            needsLogin: Boolean(error && error.needsLogin),
            error: error && error.message ? error.message : String(error),
          }
        }
        sendJson(response, 200, result)
      },
    })
    return () => {
      dispose()
      sessions.clear()
    }
  })
}
