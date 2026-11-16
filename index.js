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

async function getLogs(session, { startTimestamp, endTimestamp, maxPages = 8, pageSize = 100 }) {
  const items = []
  let total
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ p: String(page), page_size: String(pageSize), type: '2' })
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
    if (list.length < pageSize) break
    if (typeof total === 'number' && items.length >= total) break
  }
  // 同时返回总数：调用方按 total 决定要不要再切片，避免盲目翻页。
  return { items, total: typeof total === 'number' ? total : items.length }
}

/**
 * 按「天 × 时段」分段拉取日志。
 *
 * 背景（实测 hohai 站点）：
 *   - `/api/log/self` 按 created_at **倒序**返回，`page_size` 上限 100；
 *   - 响应里的 `total` 是该区间内的真实总数（实测单日 600~2200 条）；
 *   - 只翻有限的页时，拿到的永远是区间内**最新**的那部分，早期记录全部丢失。
 *
 * 所以策略是：把每天再切成 hourChunk 小时的小段，逐段请求。单段记录数通常 < 100，
 * 一次就能取全；即使某段仍超限，也只会丢这一小段的尾部，不会影响其他日期与时段。
 *
 * 每段独立 try/catch：单段失败不影响整体。
 */
// 替换 getLogsByDay：并发 + 自适应切片 + 内容去重
async function getLogsByDay(session, { days = 21, concurrency = 10, pageSize = 100 } = {}) {
  const now = Date.now()
  const todayStart = startOfDay(now)
  const all = []
  const seen = new Set()

  /** 有并发上限的任务池，避免一次性打爆站点。 */
  async function pool(tasks, limit) {
    const results = []
    let cursor = 0
    const workers = new Array(Math.min(limit, tasks.length || 1)).fill(0).map(async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= tasks.length) return
        results[index] = await tasks[index]()
      }
    })
    await Promise.all(workers)
    return results
  }

  /** 单个时间窗请求（一页即可，页大小自适应）。 */
  async function fetchWindow(startMs, endMs) {
    try {
      const result = await getLogs(session, {
        startTimestamp: Math.floor(startMs / 1000),
        endTimestamp: Math.floor(endMs / 1000),
        maxPages: 1,
        pageSize,
      })
      return { items: result.items ?? [], total: result.total ?? 0 }
    } catch {
      return { items: [], total: 0 }
    }
  }

  // 每天先取一页，读 total；total 超过一页时，按 total 把当天等分成若干窗口再并发取。
  const dayTasks = []
  for (let offset = 0; offset < days; offset += 1) {
    const dayStart = todayStart - offset * DAY_MS
    const dayEnd = dayStart + DAY_MS
    dayTasks.push(async () => {
      const first = await fetchWindow(dayStart, dayEnd)
      const collected = [...first.items]
      const total = first.total || first.items.length
      const slices = Math.ceil(total / pageSize)
      if (slices > 1) {
        const span = DAY_MS / slices
        const subTasks = []
        for (let i = 0; i < slices; i += 1) {
          const s = dayStart + i * span
          const e = Math.min(s + span, dayEnd)
          subTasks.push(async () => (await fetchWindow(s, e)).items)
        }
        const parts = await pool(subTasks, concurrency)
        for (const part of parts) collected.push(...part)
      }
      return collected
    })
  }

  const perDay = await pool(dayTasks, concurrency)

  for (const items of perDay) {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      // 去重键：不能用 item.id —— new-api 返回的 id 是页内序号，跨页重复。
      const id = [
        item.created_at,
        item.model_name,
        item.quota,
        item.prompt_tokens,
        item.completion_tokens,
        item.use_time,
        item.token_name,
        item.channel,
      ].join('|')
      if (seen.has(id)) continue
      seen.add(id)
      all.push(item)
    }
  }

  return all
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

/* ------------------------------------------------------------------ *
 * 区间统计：今日 / 本周 / 上周 / 上上周 / 本月 / 上月 / 今年
 *
 * 参考「用量趋势」这类面板需要的不只是 7 天柱状图，还要能和上期对比（环比）。
 * 这里把一次拉回来的原始日志按多个自然区间各算一遍，前端直接取用。
 * 周起点按本地时区的周一 00:00（与站点「周一至周日」口径一致）。
 * ------------------------------------------------------------------ */

function startOfWeek(time) {
  const d = new Date(time)
  d.setHours(0, 0, 0, 0)
  const weekday = (d.getDay() + 6) % 7 // 周一 = 0
  return d.getTime() - weekday * DAY_MS
}

function startOfMonth(time) {
  const d = new Date(time)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

function startOfYear(time) {
  const d = new Date(time)
  return new Date(d.getFullYear(), 0, 1).getTime()
}

function emptyRange() {
  return { quota: 0, requests: 0, tokens: 0 }
}

/** 环比：上期为 0 时返回 null（前端显示「—」），避免出现 Infinity%。 */
function ratioOf(current, previous) {
  if (!previous || !Number.isFinite(previous) || previous <= 0) return null
  return (current - previous) / previous
}

function computeRanges(items, quotaPerUnit) {
  const now = Date.now()
  const todayStart = startOfDay(now)
  const tomorrowStart = todayStart + DAY_MS

  const weekStart = startOfWeek(now)
  const lastWeekStart = weekStart - 7 * DAY_MS
  const prevWeekStart = weekStart - 14 * DAY_MS

  const monthStart = startOfMonth(now)
  const lastMonthStart = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() - 1, 1).getTime()
  const yearStart = startOfYear(now)

  const buckets = {
    today: emptyRange(),
    yesterday: emptyRange(),
    week: emptyRange(),
    lastWeek: emptyRange(),
    prevWeek: emptyRange(),
    month: emptyRange(),
    lastMonth: emptyRange(),
    year: emptyRange(),
  }

  const daily = new Map()

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const createdSeconds = numberOrZero(item.created_at)
    if (!createdSeconds) continue
    const createdMs = createdSeconds * 1000

    const quota = numberOrZero(item.quota)
    const tokens = numberOrZero(item.prompt_tokens) + numberOrZero(item.completion_tokens)

    const add = (bucket) => {
      bucket.quota += quota
      bucket.requests += 1
      bucket.tokens += tokens
    }

    if (createdMs >= todayStart && createdMs < tomorrowStart) add(buckets.today)
    if (createdMs >= todayStart - DAY_MS && createdMs < todayStart) add(buckets.yesterday)
    if (createdMs >= weekStart) add(buckets.week)
    if (createdMs >= lastWeekStart && createdMs < weekStart) add(buckets.lastWeek)
    if (createdMs >= prevWeekStart && createdMs < lastWeekStart) add(buckets.prevWeek)
    if (createdMs >= monthStart) add(buckets.month)
    if (createdMs >= lastMonthStart && createdMs < monthStart) add(buckets.lastMonth)
    if (createdMs >= yearStart) add(buckets.year)

    const key = dayKeyOf(new Date(createdMs))
    const day = daily.get(key) ?? { date: key, quota: 0, requests: 0, tokens: 0 }
    day.quota += quota
    day.requests += 1
    day.tokens += tokens
    daily.set(key, day)
  }

  const convert = (quota) => (quotaPerUnit ? quota / quotaPerUnit : 0)
  const withAmount = (bucket) => ({ ...bucket, amount: convert(bucket.quota) })

  const today = withAmount(buckets.today)
  const yesterday = withAmount(buckets.yesterday)
  const week = withAmount(buckets.week)
  const lastWeek = withAmount(buckets.lastWeek)
  const prevWeek = withAmount(buckets.prevWeek)
  const month = withAmount(buckets.month)
  const lastMonth = withAmount(buckets.lastMonth)
  const year = withAmount(buckets.year)

  return {
    ranges: {
      today,
      yesterday,
      week,
      lastWeek,
      prevWeek,
      month,
      lastMonth,
      year,
      // 环比：上周 vs 上上周；本月 vs 上月；今日 vs 昨日
      compare: {
        todayVsYesterday: {
          amount: ratioOf(today.amount, yesterday.amount),
          tokens: ratioOf(today.tokens, yesterday.tokens),
          requests: ratioOf(today.requests, yesterday.requests),
        },
        lastWeekVsPrevWeek: {
          amount: ratioOf(lastWeek.amount, prevWeek.amount),
          tokens: ratioOf(lastWeek.tokens, prevWeek.tokens),
          requests: ratioOf(lastWeek.requests, prevWeek.requests),
        },
        monthVsLastMonth: {
          amount: ratioOf(month.amount, lastMonth.amount),
          tokens: ratioOf(month.tokens, lastMonth.tokens),
          requests: ratioOf(month.requests, lastMonth.requests),
        },
      },
      // 上周的日均（按 7 天算）
      lastWeekDaily: {
        amount: lastWeek.amount / 7,
        tokens: lastWeek.tokens / 7,
        requests: lastWeek.requests / 7,
      },
      // 有请求的天数（上周区间内）
      lastWeekActiveDays: [...daily.keys()].filter((key) => {
        const t = new Date(`${key}T00:00:00`).getTime()
        return t >= lastWeekStart && t < weekStart && (daily.get(key)?.requests ?? 0) > 0
      }).length,
    },
    daily: [...daily.values()]
      .map((day) => ({ ...day, amount: convert(day.quota) }))
      .sort((left, right) => (left.date < right.date ? -1 : 1)),
    bounds: {
      weekStart,
      lastWeekStart,
      prevWeekStart,
      monthStart,
      lastMonthStart,
      yearStart,
      todayStart,
    },
  }
}

function summarizeLogs(items, quotaPerUnit) {  const now = Date.now()
  const todayStart = startOfDay(now)
  const todayEnd = todayStart + DAY_MS
  const weekStart = todayStart - 6 * DAY_MS

  const dayBuckets = new Map()
  // 从 6 天前建到今天（含今天），与 weekStart 对齐。
  // 旧写法是 todayStart + offset * DAY_MS，建出的是「今天及未来 6 天」，
  // 历史日志找不到对应桶会被整段丢弃，趋势图于是只显示今天一天。
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(todayStart - offset * DAY_MS)
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

  // 两段式加载：先拉最近 7 天立即出图，21 天数据放后台补齐。
  // 打开面板时不再等 21 天（约 5.6s），首屏通常 1~2s。
  // 与前端 5 分钟自动刷新对齐：期内重复打开直接复用，避免无意义的重复拉取。
  const CACHE_TTL_MS = 5 * 60 * 1000
  const force = Boolean(session.__forceRefresh)
  if (!force && session.__cache && Date.now() - session.__cache.at < CACHE_TTL_MS) {
    return session.__cache.value
  }

  const FAST_DAYS = 7
  const FULL_DAYS = 21

  const fastLogs = await getLogsByDay(session, { days: FAST_DAYS, concurrency: 10, pageSize: 100 })
  const fastSummary = summarizeLogs(fastLogs, quotaPerUnit)
  const fastRanges = computeRanges(fastLogs, quotaPerUnit)

  const quota = numberOrZero(user.quota)
  const usedQuota = numberOrZero(user.used_quota)

  const buildValue = (summary, ranges, complete) => ({
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
    ranges: ranges.ranges,
    daily: ranges.daily,
    // complete=false 表示目前只有最近 7 天，前端可据此提示「正在补全」
    complete,
    coveredDays: complete ? FULL_DAYS : FAST_DAYS,
    fetchedAt: Date.now(),
  })

  const fast = buildValue(fastSummary, fastRanges, false)
  session.__cache = { at: Date.now(), value: fast }

  // 后台补齐 21 天：不阻塞本次响应。同一会话并发多次打开时只跑一次。
  if (!session.__filling) {
    session.__filling = (async () => {
      try {
        const fullLogs = await getLogsByDay(session, { days: FULL_DAYS, concurrency: 10, pageSize: 100 })
        const fullValue = buildValue(
          summarizeLogs(fullLogs, quotaPerUnit),
          computeRanges(fullLogs, quotaPerUnit),
          true,
        )
        session.__cache = { at: Date.now(), value: fullValue }
      } catch {
        // 失败了就保持 7 天版本，前端下次刷新会再试
      } finally {
        session.__filling = null
      }
    })()
  }

  return fast
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

    // ---------------------------------------------------------------
    // 诊断用：逐日返回 /api/log/self 的原始响应特征。
    // 只用于定位「趋势图只有一天」的问题，不参与正常渲染。
    // 登录后调用 action=debug-logs 即可看到每天请求的真实结果。
    // ---------------------------------------------------------------
    if (action === 'debug-logs') {
      const session = sessions.get(String(payload.sessionId ?? ''))
      if (!session) return { ok: false, needsLogin: true, error: '会话已过期，请重新登录' }

      const days = Number(payload.days) || 7
      const pageSize = String(payload.pageSize ?? '100')
      const type = payload.type === undefined ? '2' : String(payload.type)
      const usePage = String(payload.p ?? '0')
      const now = Date.now()
      const todayStart = startOfDay(now)
      const out = []

      for (let offset = 0; offset < days; offset += 1) {
        const dayStart = todayStart - offset * DAY_MS
        const dayEnd = dayStart + DAY_MS
        const query = new URLSearchParams({
          p: usePage,
          page_size: pageSize,
          type,
          start_timestamp: String(Math.floor(dayStart / 1000)),
          end_timestamp: String(Math.floor(dayEnd / 1000)),
        })

        const row = {
          date: new Date(dayStart).toISOString().slice(0, 10),
          start: Math.floor(dayStart / 1000),
          end: Math.floor(dayEnd / 1000),
          requested: query.toString(),
        }

        try {
          const result = await authedGet(session, `/api/log/self?${query.toString()}`)
          const j = result.json
          const data = j?.data
          const list = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : []
          row.httpOk = true
          row.success = j?.success ?? null
          row.message = j?.message ?? null
          row.dataKind = Array.isArray(data) ? 'array' : data && typeof data === 'object' ? 'object' : typeof data
          row.itemsLen = list.length
          row.total = typeof data?.total === 'number' ? data.total : null
          // 抽样第一条，看 created_at 单位与字段名
          if (list[0]) {
            const it = list[0]
            row.sample = {
              created_at: it.created_at,
              created_at_type: typeof it.created_at,
              created_at_as_date: (() => {
                const v = Number(it.created_at)
                if (!Number.isFinite(v) || !v) return null
                // 猜单位：秒(10位) / 毫秒(13位)
                const ms = String(Math.trunc(v)).length >= 12 ? v : v * 1000
                return new Date(ms).toISOString()
              })(),
              quota: it.quota,
              type: it.type,
              model_name: it.model_name,
            }
          }
          // 当天区间内实际命中几条（按 created_at 判断）
          let inRange = 0
          for (const it of list) {
            const v = Number(it?.created_at)
            if (!Number.isFinite(v) || !v) continue
            const ms = String(Math.trunc(v)).length >= 12 ? v : v * 1000
            if (ms >= dayStart && ms < dayEnd) inRange += 1
          }
          row.inRange = inRange
        } catch (error) {
          row.httpOk = false
          row.error = String(error && error.message ? error.message : error).slice(0, 300)
        }

        out.push(row)
      }

      return { ok: true, baseUrl: session.baseUrl, days: out }
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
      // payload.refresh = true 时跳过缓存（对应界面上的「刷新」按钮）
      session.__forceRefresh = Boolean(payload.refresh)
      try {
        const overview = await buildOverview(session)
        return { ok: true, overview }
      } finally {
        session.__forceRefresh = false
      }
    }

    if (action === 'ping') {
      return { ok: true, version: '1.7.0' }
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
