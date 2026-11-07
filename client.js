/**
 * Relay station usage — Client half.
 *
 * - Sidebar entry: `sidebar.panellist` id `relay`.
 * - Panel body: `main` keyed slot `relay`.
 * - Colours come only from `--dsw-alias-*` tokens, so both themes follow.
 *
 * The restricted client ctx only exposes services listed in `inject`, and this
 * module deliberately touches none of them: language comes from the document /
 * browser hint and is refreshed by the `locale/change` event.
 */

window.__ModuleLoader__.load({
  id: '@desstg/dsh-relay-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const API_PATH = '/relay-usage/api'
    const STORE_STATIONS = 'dsh.relay-usage.stations.v2'
    const STORE_ACTIVE = 'dsh.relay-usage.active.v2'
    const STORE_SESSIONS = 'dsh.relay-usage.sessions.v2'
    /* Keys used by earlier builds; read once so saved stations are not lost. */
    const LEGACY_KEYS = {
      stations: 'dsh.relay-usage.stations.v1',
      active: 'dsh.relay-usage.active.v1',
      sessions: 'dsh.relay-usage.sessions.v1',
    }
    const DEFAULT_BASE = 'https://api.hohai.eu.org'
    const REFRESH_MS = 60 * 1000

    const DICT = {
      zh: {
        nav: '中转站',
        title: '中转站',
        subtitle: '登录你自己的中转站账号，查看余额与消耗。',
        siteUrl: '站点地址',
        username: '用户名',
        password: '密码',
        remember: '记住凭据（仅保存在本机浏览器）',
        signIn: '登录',
        signingIn: '正在登录…',
        useToken: '使用访问令牌登录',
        usePassword: '使用账号密码登录',
        token: '访问令牌',
        tokenHint: '令牌在站点「控制台 → 个人设置 → 访问令牌」创建。新版站点是 nap_ 开头的令牌，且必须具备读取个人信息的权限。',
        addStation: '添加站点',
        cancel: '取消',
        refresh: '刷新',
        refreshing: '刷新中…',
        signOut: '退出',
        balance: '余额',
        usedAmount: '累计已用',
        todayAmount: '今日消耗',
        todayRequests: '今日请求',
        todayTokens: '今日 Token',
        totalRequests: '累计请求',
        weekTitle: '近 7 日',
        modelsTitle: '模型用量',
        logsTitle: '最近消费',
        colTime: '时间',
        colModel: '模型',
        colTokens: 'Token',
        colAmount: '金额',
        quotaUnit: '额度',
        times: '次',
        empty: '暂无数据',
        account: '账户',
        updated: '更新于',
        stationFallback: '中转站',
        remove: '移除',
        errEmpty: '请填写站点地址、用户名和密码。',
        loading: '读取中…',
        noStations: '还没有配置中转站',
        noStationsHint: '填一次账号，之后自动登录；支持多个中转站与 DeepSeek 官方余额。',
        retry: '重试',
        autoRefresh: '每 60 秒自动刷新',
        granted: '赠送余额',
        toppedUp: '充值余额',
        available: '账户可用',
        unavailable: '账户不可用',
        officialNote: '官方站数据取自平台接口（余额、本月消费与本月 Token），没有按模型的逐条明细。',
        officialTitle: '说明',
        monthRequests: '本月请求',
        monthCost: '本月消费',
        monthTokens: '本月 Token',
        rawTitle: '接口原始数据',
        officialNoFields: '已登录，但平台返回里没有识别到余额/用量字段——展开下面的原始数据可核对。',
        officialHint: '官方站是「手机号 + 验证码」登录，插件收不到短信。请先在 platform.deepseek.com 登录，然后按 F12 → Network → 任选一个 /api/v0 请求 → 复制请求头 Authorization 里 Bearer 后面那串，粘到上面。若你的账号设过密码，也可切回密码登录。',
        modePassword: '账号密码',
        modeToken: '访问令牌',
        authFoot: '凭据只保存在本机浏览器；Host 仅在内存里持有会话，不落盘。',
        trendTitle: '用量趋势',
        rangeWeek: '近 7 日',
        rangeMonth: '本月',
        rangeToday: '今日',
        labelPerMillion: '每百万 Token 均价',
        metricAmount: '金额',
        metricToken: 'Token',
        labelTokens: 'Token 用量',
        labelCost: '费用',
        labelRequests: '请求',
        labelPerDay: '日均',
        noteTitle: '说明',
        todayTitle: '今日',        confirmRemove: '移除站点「{name}」？',
      },
      en: {
        nav: 'Relay',
        title: 'Relay station',
        subtitle: 'Sign in to your own relay account to see balance and consumption.',
        siteUrl: 'Station URL',
        username: 'Username',
        password: 'Password',
        remember: 'Remember credentials (this browser only)',
        signIn: 'Sign in',
        signingIn: 'Signing in…',
        useToken: 'Use an access token',
        usePassword: 'Use username and password',
        token: 'Access token',
        tokenHint: 'Create one under Console → Personal settings → Access tokens. Newer sites issue nap_ prefixed tokens that must include personal read access.',
        addStation: 'Add station',
        cancel: 'Cancel',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        signOut: 'Sign out',
        balance: 'Balance',
        usedAmount: 'Used so far',
        todayAmount: 'Spent today',
        todayRequests: 'Requests today',
        todayTokens: 'Tokens today',
        totalRequests: 'Total requests',
        weekTitle: 'Last 7 days',
        modelsTitle: 'By model',
        logsTitle: 'Recent',
        colTime: 'Time',
        colModel: 'Model',
        colTokens: 'Tokens',
        colAmount: 'Amount',
        quotaUnit: 'quota',
        times: 'req',
        empty: 'No data',
        account: 'Account',
        updated: 'Updated',
        stationFallback: 'Relay station',
        remove: 'Remove',
        errEmpty: 'Station URL, username, and password are required.',
        loading: 'Loading…',
        noStations: 'No relay station yet',
        noStationsHint: 'Sign in once and it is remembered. Several stations and the official DeepSeek balance are supported.',
        retry: 'Retry',
        autoRefresh: 'auto-refresh every 60 s',
        granted: 'Granted',
        toppedUp: 'Topped up',
        available: 'Account active',
        unavailable: 'Account unavailable',
        officialNote: 'The official platform reports balance plus this month\'s cost and tokens; it publishes no per-model detail.',
        officialTitle: 'Notes',
        monthRequests: 'Requests this month',
        monthCost: 'This month',
        monthTokens: 'Tokens this month',
        rawTitle: 'Raw API data',
        officialNoFields: 'Signed in, but no balance or usage field was recognised in the platform response. Expand the raw data below.',
        officialHint: 'The official site signs in with a phone number plus an SMS code, which this panel cannot receive. Sign in on platform.deepseek.com, then press F12 → Network → open any /api/v0 request → copy what follows "Bearer" in its Authorization header and paste it above. Password sign-in is still available if your account has one.',
        modePassword: 'Account',
        modeToken: 'Token',
        authFoot: 'Credentials stay in this browser; the host only keeps the session in memory.',
        trendTitle: 'Usage trend',
        rangeWeek: 'Last 7 days',
        rangeMonth: 'This month',
        rangeToday: 'Today',
        labelPerMillion: 'Avg per 1M tokens',
        metricAmount: 'Cost',
        metricToken: 'Tokens',
        labelTokens: 'Tokens',
        labelCost: 'Cost',
        labelRequests: 'Requests',
        labelPerDay: 'Daily avg',
        noteTitle: 'Notes',
        todayTitle: 'Today',        confirmRemove: 'Remove station "{name}"?',
      },
    }

    /* ---------------------------- language ---------------------------- */

    const localeWatchers = new Set()

    function notifyLocaleChange() {
      for (const watcher of localeWatchers) {
        try {
          watcher()
        } catch {
          /* one bad watcher must not break the rest */
        }
      }
    }

    function detectLanguage() {
      const candidates = []
      try {
        if (document && document.documentElement && document.documentElement.lang) {
          candidates.push(document.documentElement.lang)
        }
      } catch {
        /* ignore */
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.language) candidates.push(navigator.language)
      } catch {
        /* ignore */
      }
      return candidates.find((value) => typeof value === 'string' && value.length > 0) || ''
    }

    function activeDict() {
      return /^zh\b|^zh[-_]/i.test(detectLanguage()) ? DICT.zh : DICT.en
    }

    function translate(dict, key, vars) {
      let text = dict[key] ?? DICT.zh[key] ?? key
      if (vars) {
        for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value))
      }
      return text
    }

    /* ----------------------------- storage ----------------------------- */

    function readStore(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (!raw) return fallback
        return JSON.parse(raw)
      } catch {
        return fallback
      }
    }

    function writeStore(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* private mode: keep working in memory */
      }
    }

    /** Reads the current key, falling back to the previous build's key once. */
    function readStoreWithLegacy(key, legacyKey, fallback) {
      const current = readStore(key, undefined)
      if (current !== undefined && current !== null) return current
      const legacy = readStore(legacyKey, fallback)
      try {
        if (legacy !== fallback) writeStore(key, legacy)
      } catch {
        /* ignore */
      }
      return legacy
    }

    function newId() {
      return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
    }

    /* ---------------------------- formatting --------------------------- */

    function fmtAmount(value, symbol) {
      const number = Number(value) || 0
      const fixed = Math.abs(number) >= 10000 ? number.toFixed(0) : number.toFixed(2)
      const [whole, decimals] = fixed.split('.')
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return `${symbol || ''}${decimals ? `${grouped}.${decimals}` : grouped}`
    }

    function trimZeros(text) {
      return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    }

    function fmtTokens(value) {
      const number = Number(value) || 0
      if (number >= 1e8) return `${trimZeros((number / 1e8).toFixed(2))}亿`
      if (number >= 1e4) return `${trimZeros((number / 1e4).toFixed(1))}万`
      return String(Math.round(number))
    }

    function fmtInt(value) {
      return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function fmtClock(ms) {
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function fmtStamp(ms) {
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function hostOf(baseUrl) {
      try {
        return new URL(baseUrl).host
      } catch {
        return String(baseUrl || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      }
    }

    function looksOfficial(baseUrl) {
      const host = hostOf(baseUrl).toLowerCase()
      return host === 'deepseek.com' || host.endsWith('.deepseek.com')
    }

    /* ------------------------------ styles ----------------------------- */

    const CSS = `
.rgu-root { box-sizing: border-box; width: 100%; max-width: 1080px; margin: 0 auto; padding: 18px 24px 24px; display: flex; flex-direction: column; gap: 9px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); min-height: 100%; height: 100%; overflow-y: auto; overflow-x: hidden; font-size: 13px; }
.rgu-root::-webkit-scrollbar { width: 8px; height: 8px; }
.rgu-root::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dsw-alias-border-l2) 70%, transparent); border-radius: 4px; }
.rgu-root::-webkit-scrollbar-track { background: transparent; }
.rgu-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.rgu-id { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rgu-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; align-self: center; background: var(--dsw-alias-state-idle-primary); }
.rgu-dot[data-state="ready"] { background: var(--dsw-alias-state-success-primary); }
.rgu-dot[data-state="error"] { background: var(--dsw-alias-state-error-primary); }
.rgu-dot[data-state="busy"] { background: var(--dsw-alias-state-warn-primary); }
.rgu-name { font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.rgu-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rgu-tools { display: flex; align-items: center; gap: 6px; }
.rgu-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 11px; font-size: 12px; line-height: 18px; cursor: pointer; white-space: nowrap; transition: background .15s, border-color .15s; }
.rgu-btn:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.rgu-btn:disabled { opacity: .5; cursor: default; }
.rgu-btn[data-variant="primary"] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 48%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-brand-primary); }
.rgu-btn[data-variant="ghost"] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.rgu-btn[data-variant="ghost"]:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.rgu-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rgu-chip { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 3px 11px; font-size: 11px; line-height: 16px; cursor: pointer; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rgu-chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.rgu-chip[data-active="true"] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }
.rgu-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 10px; }
.rgu-scard { position: relative; overflow: hidden; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 13px 15px; display: flex; flex-direction: column; gap: 5px; min-width: 0; transition: border-color .15s; }
.rgu-scard:hover { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, var(--dsw-alias-border-l1)); }
.rgu-scard-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rgu-scard-value { font-size: 25px; font-weight: 600; line-height: 1.15; letter-spacing: .2px; font-variant-numeric: tabular-nums; }
.rgu-scard-value[data-accent="brand"] { color: var(--dsw-alias-brand-primary); }
.rgu-scard-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rgu-section { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 12px 15px; display: flex; flex-direction: column; gap: 11px; min-width: 0; }
.rgu-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.rgu-section-title { font-size: 13px; font-weight: 600; }
.rgu-section-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rgu-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); }
.rgu-tab { appearance: none; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; padding: 4px 11px; border-radius: 999px; cursor: pointer; }
.rgu-tab:hover { color: var(--dsw-alias-label-primary); }
.rgu-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 1px var(--dsw-alias-border-l1); }
.rgu-trend { display: flex; align-items: baseline; gap: 22px; flex-wrap: wrap; }
.rgu-tnum { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rgu-tnum-value { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: .2px; }
.rgu-tnum-label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.rgu-split { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 10px; }
@media (max-width: 900px) { .rgu-split { grid-template-columns: minmax(0, 1fr); } }
.rgu-bars { display: flex; align-items: flex-end; gap: 8px; height: 118px; padding-top: 2px; }
.rgu-bar-col { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; justify-content: flex-end; }
.rgu-bar-track { width: 100%; flex: 1; display: flex; align-items: flex-end; }
.rgu-bar { width: 100%; border-radius: 5px 5px 2px 2px; background: linear-gradient(180deg, #4F7BD9 0%, #2B5BB5 100%); min-height: 3px; transition: height .25s ease, filter .15s; }
.rgu-bar-col:hover .rgu-bar { filter: brightness(1.08); }
.rgu-bar[data-zero="true"] { background: var(--dsw-alias-border-l1); }
.rgu-bar-label { font-size: 9px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.rgu-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(52px, auto) minmax(58px, auto); gap: 8px; align-items: center; font-size: 12px; }
.rgu-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rgu-row-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.rgu-track { height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.rgu-fill { height: 100%; background: linear-gradient(90deg, #4F7BD9 0%, #2B5BB5 100%); opacity: 1; }
.rgu-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.rgu-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; font-size: 11px; }
.rgu-table td { padding: 4px 6px; border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 55%, transparent); font-variant-numeric: tabular-nums; }
.rgu-table tr:last-child td { border-bottom: none; }
.rgu-table tbody tr:hover td { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 60%, transparent); }
.rgu-table td[data-align="right"], .rgu-table th[data-align="right"] { text-align: right; }
.rgu-mono { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.rgu-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 6px 0; line-height: 18px; }
.rgu-note { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 19px; }
.rgu-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); border-radius: 8px; padding: 7px 11px; }
.rgu-card { max-width: 372px; margin: 6vh auto 0; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 11px; }
.rgu-card h2 { margin: 0; font-size: 15px; font-weight: 600; }
.rgu-card p { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 17px; }
.rgu-field { display: flex; flex-direction: column; gap: 4px; }
.rgu-field label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rgu-input { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 7px 9px; font-size: 12px; outline: none; transition: border-color .15s; }
.rgu-input:focus { border-color: var(--dsw-alias-brand-primary); }
.rgu-check { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rgu-link { background: none; border: none; color: var(--dsw-alias-brand-primary); font-size: 11px; cursor: pointer; padding: 0; text-align: left; }
.rgu-foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.rgu-bars[data-tall="true"] { height: 136px; }
.rgu-bars[data-single="true"] { justify-content: flex-start; }
.rgu-bars[data-single="true"] .rgu-bar-col { max-width: 96px; }
.rgu-metric { display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); align-self: center; }
.rgu-axis { font-size: 10px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.rgu-tnum-value { font-size: 25px; }.rgu-raw { margin: 6px 0 0; font-size: 10px; line-height: 15px; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; color: var(--dsw-alias-label-secondary); }
.rgu-auth { display: flex; align-items: center; justify-content: center; min-height: 100%; padding: 30px 20px; }
.rgu-auth-card { width: 100%; max-width: 404px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; padding: 22px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 10px 30px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.rgu-auth-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.rgu-auth-logo { flex: none; width: 38px; height: 38px; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, var(--dsw-alias-bg-layer-1)); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent); color: var(--dsw-alias-brand-primary); }
.rgu-auth-title { font-size: 15px; font-weight: 600; }
.rgu-auth-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 16px; margin-top: 3px; }
.rgu-modes { display: flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); }
.rgu-mode { flex: 1; appearance: none; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; padding: 6px 10px; border-radius: 999px; cursor: pointer; }
.rgu-mode:hover { color: var(--dsw-alias-label-primary); }
.rgu-mode[data-active="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 1px var(--dsw-alias-border-l1); }
.rgu-auth-form { display: flex; flex-direction: column; gap: 11px; }
.rgu-auth-actions { display: flex; gap: 8px; margin-top: 2px; }
.rgu-auth-actions .rgu-btn { padding: 8px 12px; font-size: 13px; border-radius: 9px; }
.rgu-auth-actions .rgu-btn[data-variant="primary"] { flex: 1; }
.rgu-auth-foot { font-size: 10px; color: var(--dsw-alias-label-secondary); text-align: center; line-height: 16px; }
.rgu-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 17px; }
`

    /* ----------------------------- requests ---------------------------- */

    function reportClientError(where, error) {
      try {
        fetch(new URL(API_PATH, window.location.origin).href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'client-error',
            where: String(where || ''),
            message: String((error && error.message) || error || ''),
            stack: String((error && error.stack) || '').slice(0, 4000),
          }),
        }).catch(() => {})
      } catch {
        /* reporting must never throw */
      }
    }

    async function callHost(payload) {
      let response
      try {
        response = await fetch(new URL(API_PATH, window.location.origin).href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch {
        throw new Error('无法连接本机服务，请重启 Harness 后再试。')
      }
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      if (!json) throw new Error(`本机服务返回了无法解析的响应（HTTP ${response.status}）`)
      return json
    }

    /* ------------------------------ views ------------------------------ */

    function WeekBars({ days, tall, single, metric }) {
      const list = Array.isArray(days) ? days : []
      if (!list.length) return h('div', { className: 'rgu-empty' }, '—')
      const valueOf = (day) =>
        metric === 'token' ? Number(day.tokens ?? day.quota) || 0 : Number(day.amount) || 0
      const peak = list.reduce((max, day) => Math.max(max, valueOf(day)), 0)
      return h(
        'div',
        { className: 'rgu-bars', 'data-tall': tall ? 'true' : 'false', 'data-single': single ? 'true' : 'false' },
        ...list.map((day) => {
          const value = valueOf(day)
          /* Square-root scale: a day with 1% of the peak would otherwise be invisible. */
          const ratio = peak > 0 ? Math.max(Math.sqrt(value / peak), value > 0 ? 0.06 : 0) : 0
          return h(
            'div',
            { className: 'rgu-bar-col', key: day.key, title: `${day.label} · ¥${fmtAmount(day.amount, '')} · ${fmtTokens(day.tokens ?? day.quota)} token · ${fmtInt(day.requests)} 次` },
            h('div', { className: 'rgu-bar-track' },
              h('div', { className: 'rgu-bar', 'data-zero': value > 0 ? 'false' : 'true', style: { height: `${(ratio * 100).toFixed(1)}%` } }),
            ),
            h('div', { className: 'rgu-bar-label' }, day.label),
          )
        }),
      )
    }

    function ModelList({ models, symbol, t }) {
      const list = Array.isArray(models) ? models : []
      if (!list.length) return h('div', { className: 'rgu-empty' }, t('empty'))
      const peak = list.reduce((max, model) => Math.max(max, Number(model.quota) || 0), 0)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        ...list.slice(0, 6).map((model) =>
          h(
            'div',
            { key: model.name, style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
            h('div', { className: 'rgu-row' },
              h('div', { className: 'rgu-row-name', title: model.name }, model.name),
              h('div', { className: 'rgu-row-num' }, `${fmtInt(model.count)} ${t('times')}`),
              h('div', { className: 'rgu-row-num' }, fmtAmount(model.amount, symbol)),
            ),
            h('div', { className: 'rgu-track' },
              h('div', { className: 'rgu-fill', style: { width: `${peak > 0 ? Math.max((model.quota / peak) * 100, 2) : 0}%` } }),
            ),
          ),
        ),
      )
    }

    function LogTable({ logs, symbol, t }) {
      const list = Array.isArray(logs) ? logs : []
      if (!list.length) return h('div', { className: 'rgu-empty' }, t('empty'))
      return h(
        'table',
        { className: 'rgu-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('colTime')),
          h('th', null, t('colModel')),
          h('th', { 'data-align': 'right' }, t('colTokens')),
          h('th', { 'data-align': 'right' }, t('colAmount')),
        )),
        h('tbody', null, ...list.slice(0, 6).map((log, index) =>
          h('tr', { key: `${log.at}-${index}` },
            h('td', { className: 'rgu-mono' }, fmtStamp(log.at)),
            h('td', { className: 'rgu-row-name', title: log.model }, log.model),
            h('td', { 'data-align': 'right', className: 'rgu-mono' }, log.tokens ? fmtTokens(log.tokens) : '—'),
            h('td', { 'data-align': 'right', className: 'rgu-mono' }, fmtAmount(log.amount, symbol)),
          ),
        )),
      )
    }

    function StationChips({ stations, activeId, onSwitch }) {
      if (!Array.isArray(stations) || stations.length < 2) return null
      return h(
        'div',
        { className: 'rgu-chips' },
        ...stations.map((station) =>
          h('button', {
            key: station.id,
            type: 'button',
            className: 'rgu-chip',
            'data-active': station.id === activeId ? 'true' : 'false',
            title: station.baseUrl,
            onClick: () => onSwitch(station),
          }, station.label || hostOf(station.baseUrl)),
        ),
      )
    }

    function LoginCard({ t, stations, busy, error, onSubmit, onCancel, onSwitch, activeId, initialBase }) {
      const [baseUrl, setBaseUrl] = useState(initialBase || DEFAULT_BASE)
      const [username, setUsername] = useState('')
      const [password, setPassword] = useState('')
      const [remember, setRemember] = useState(true)
      const [pickedMode, setPickedMode] = useState(null)
      const [token, setToken] = useState('')

      const officialSite = looksOfficial(baseUrl)
      const mode = pickedMode ?? (officialSite ? 'token' : 'password')

      const submit = (event) => {
        event.preventDefault()
        onSubmit({
          baseUrl: baseUrl.trim(),
          username: username.trim(),
          password,
          remember,
          token: mode === 'token' ? token.trim() : '',
        })
      }

      return h(
        'div',
        { className: 'rgu-auth' },
        h(
          'div',
          { className: 'rgu-auth-card' },
          h(
            'div',
            { className: 'rgu-auth-head' },
            h('div', { className: 'rgu-auth-logo' }, h(NavIcon, { size: 20, active: true })),
            h(
              'div',
              null,
              h('div', { className: 'rgu-auth-title' }, t('title')),
              h('div', { className: 'rgu-auth-sub' }, stations && stations.length ? t('subtitle') : t('noStationsHint')),
            ),
          ),
          stations && stations.length ? h(StationChips, { stations, activeId, onSwitch }) : null,
          h(
            'div',
            { className: 'rgu-modes', role: 'tablist' },
            h('button', {
              className: 'rgu-mode',
              type: 'button',
              role: 'tab',
              'data-active': mode === 'password' ? 'true' : 'false',
              onClick: () => setPickedMode('password'),
            }, t('modePassword')),
            h('button', {
              className: 'rgu-mode',
              type: 'button',
              role: 'tab',
              'data-active': mode === 'token' ? 'true' : 'false',
              onClick: () => setPickedMode('token'),
            }, t('modeToken')),
          ),
          error ? h('div', { className: 'rgu-error' }, error) : null,
          h(
            'form',
            { className: 'rgu-auth-form', onSubmit: submit },
            h('div', { className: 'rgu-field' },
              h('label', { htmlFor: 'rgu-base' }, t('siteUrl')),
              h('input', {
                id: 'rgu-base',
                className: 'rgu-input',
                value: baseUrl,
                spellCheck: false,
                autoComplete: 'url',
                placeholder: 'https://api.example.com',
                onChange: (event) => setBaseUrl(event.target.value),
              }),
            ),
            mode === 'token'
              ? h('div', { className: 'rgu-field' },
                  h('label', { htmlFor: 'rgu-token' }, t('token')),
                  h('input', {
                    id: 'rgu-token',
                    className: 'rgu-input',
                    value: token,
                    spellCheck: false,
                    placeholder: 'sk-… / nap_…',
                    onChange: (event) => setToken(event.target.value),
                  }),
                )
              : [
                  h('div', { className: 'rgu-field', key: 'u' },
                    h('label', { htmlFor: 'rgu-user' }, t('username')),
                    h('input', {
                      id: 'rgu-user',
                      className: 'rgu-input',
                      value: username,
                      spellCheck: false,
                      autoComplete: 'username',
                      onChange: (event) => setUsername(event.target.value),
                    }),
                  ),
                  h('div', { className: 'rgu-field', key: 'p' },
                    h('label', { htmlFor: 'rgu-pass' }, t('password')),
                    h('input', {
                      id: 'rgu-pass',
                      className: 'rgu-input',
                      type: 'password',
                      value: password,
                      autoComplete: 'current-password',
                      onChange: (event) => setPassword(event.target.value),
                    }),
                  ),
                ],
            mode === 'token' && !officialSite ? h('div', { className: 'rgu-hint' }, t('tokenHint')) : null,
            officialSite ? h('div', { className: 'rgu-hint' }, t('officialHint')) : null,
            h('label', { className: 'rgu-check' },
              h('input', { type: 'checkbox', checked: remember, onChange: (event) => setRemember(event.target.checked) }),
              h('span', null, t('remember')),
            ),
            h('div', { className: 'rgu-auth-actions' },
              h('button', { className: 'rgu-btn', type: 'submit', 'data-variant': 'primary', disabled: busy },
                busy ? t('signingIn') : t('signIn')),
              onCancel ? h('button', { className: 'rgu-btn', type: 'button', 'data-variant': 'ghost', onClick: onCancel }, t('cancel')) : null,
            ),
          ),
          h('div', { className: 'rgu-auth-foot' }, t('authFoot')),
        ),
      )
    }

    function StatCard({ label, value, hint, accent }) {
      return h(
        'div',
        { className: 'rgu-scard' },
        h('div', { className: 'rgu-scard-label' }, label),
        h('div', { className: 'rgu-scard-value', 'data-accent': accent || undefined }, value),
        hint ? h('div', { className: 'rgu-scard-hint' }, hint) : null,
      )
    }

    function Section({ title, hint, children }) {
      return h(
        'section',
        { className: 'rgu-section' },
        h('div', { className: 'rgu-section-head' },
          h('div', { className: 'rgu-section-title' }, title),
          hint ? h('div', { className: 'rgu-section-hint' }, hint) : null,
        ),
        children,
      )
    }

    function TrendBlock({ days, symbol, t }) {
      const [range, setRange] = useState('week')
      const [metric, setMetric] = useState('amount')
      const all = Array.isArray(days) ? days : []
      const canMonth = all.length > 7
      const active = range === 'month' && canMonth ? 'month' : range
      const slice = active === 'today' ? all.slice(-1) : active === 'month' ? all : all.slice(-7)
      const total = (key) =>
        slice.reduce(
          (sum, day) => sum + (Number(day[key] ?? (key === 'tokens' ? day.quota : 0)) || 0),
          0,
        )
      const tokens = total('tokens')
      const amount = total('amount')
      const requests = total('requests')
      const perMillion = tokens > 0 ? (amount / tokens) * 1e6 : 0
      const first = slice[0]
      const last = slice[slice.length - 1]
      const rangeLabel = active === 'today' ? t('rangeToday') : active === 'month' ? t('rangeMonth') : t('rangeWeek')
      const span = first && last ? `${first.date || first.label} → ${last.date || last.label}` : '—'

      return h(
        'section',
        { className: 'rgu-section' },
        h('div', { className: 'rgu-section-head' },
          h('div', { className: 'rgu-section-title' }, t('trendTitle')),
          h('div', { className: 'rgu-tabs' },
            h('button', { className: 'rgu-tab', type: 'button', 'data-active': active === 'today' ? 'true' : 'false', onClick: () => setRange('today') }, t('rangeToday')),
            h('button', { className: 'rgu-tab', type: 'button', 'data-active': active === 'week' ? 'true' : 'false', onClick: () => setRange('week') }, t('rangeWeek')),
            canMonth
              ? h('button', { className: 'rgu-tab', type: 'button', 'data-active': active === 'month' ? 'true' : 'false', onClick: () => setRange('month') }, t('rangeMonth'))
              : null,
          ),
        ),
        h('div', { className: 'rgu-trend' },
          h('div', { className: 'rgu-tnum' },
            h('div', { className: 'rgu-tnum-value' }, fmtTokens(tokens)),
            h('div', { className: 'rgu-tnum-label' }, t('labelTokens')),
          ),
          h('div', { className: 'rgu-tnum' },
            h('div', { className: 'rgu-tnum-value' }, fmtAmount(amount, symbol)),
            h('div', { className: 'rgu-tnum-label' }, t('labelCost')),
          ),
          h('div', { className: 'rgu-tnum' },
            h('div', { className: 'rgu-tnum-value' }, fmtInt(requests)),
            h('div', { className: 'rgu-tnum-label' }, t('labelRequests')),
          ),
          h('div', { className: 'rgu-tnum' },
            h('div', { className: 'rgu-tnum-value' }, fmtAmount(perMillion, symbol)),
            h('div', { className: 'rgu-tnum-label' }, t('labelPerMillion')),
          ),
        ),
        h('div', { className: 'rgu-metric', style: { marginLeft: 'auto' } },
          h('button', { className: 'rgu-tab', type: 'button', 'data-active': metric === 'amount' ? 'true' : 'false', onClick: () => setMetric('amount') }, t('metricAmount')),
          h('button', { className: 'rgu-tab', type: 'button', 'data-active': metric === 'token' ? 'true' : 'false', onClick: () => setMetric('token') }, t('metricToken')),
        ),
        h(WeekBars, { days: slice, tall: true, single: slice.length === 1, metric }),
        h('div', { className: 'rgu-axis' }, `${rangeLabel}：${span}`),
      )
    }

    function Dashboard({ overview, stations, activeId, busy, error, t, onRefresh, onAdd, onSignOut, onRemove, onSwitch }) {
      const symbol = (overview.station && overview.station.symbol) || '¥'
      const account = overview.account || {}
      const wallet = overview.wallet || { balance: 0, usedAmount: 0, quota: 0, requestCount: 0 }
      const today = overview.today || { amount: 0, requests: 0, tokens: 0 }
      const week = overview.week || { days: [], amount: 0, requests: 0, tokens: 0 }
      const official = Boolean(overview.official)
      const hasNumbers = [wallet.balance, wallet.usedAmount, wallet.monthlyCost, wallet.monthlyTokens].some(
        (value) => typeof value === 'number',
      )
      const activeStation = (stations || []).find((station) => station.id === activeId)
      const models = (overview.models || []).map((item) => ({ ...item, quota: item.tokens ?? item.quota }))

      const cards = official
        ? [
            h(StatCard, { key: 'b', label: t('balance'), value: fmtAmount(wallet.balance, symbol), hint: account.displayName || undefined, accent: 'brand' }),
            h(StatCard, { key: 'm', label: t('monthCost'), value: wallet.monthlyCost === undefined ? '—' : fmtAmount(wallet.monthlyCost, symbol), hint: `${t('usedAmount')} ${fmtAmount(wallet.usedAmount, symbol)}` }),
            h(StatCard, { key: 't', label: t('monthTokens'), value: wallet.monthlyTokens === undefined ? '—' : fmtTokens(wallet.monthlyTokens), hint: `${t('todayTokens')} ${fmtTokens(today.tokens)}` }),
            h(StatCard, { key: 'r', label: t('monthRequests'), value: wallet.monthlyRequests === undefined ? '—' : fmtInt(wallet.monthlyRequests), hint: `${t('todayRequests')} ${fmtInt(today.requests)}` }),
          ]
        : [
            h(StatCard, { key: 'b', label: t('balance'), value: fmtAmount(wallet.balance, symbol), hint: `${t('quotaUnit')} ${fmtTokens(wallet.quota)}`, accent: 'brand' }),
            h(StatCard, { key: 'u', label: t('usedAmount'), value: fmtAmount(wallet.usedAmount, symbol), hint: `${t('totalRequests')} ${fmtInt(wallet.requestCount)}` }),
            h(StatCard, { key: 't', label: t('todayAmount'), value: fmtAmount(today.amount, symbol), hint: `${t('todayRequests')} ${fmtInt(today.requests)}` }),
            h(StatCard, { key: 'k', label: t('todayTokens'), value: fmtTokens(today.tokens), hint: t('todayTitle') }),
          ]

      const rightColumn = official
        ? h(Section, { title: t('noteTitle') },
            h('div', { className: 'rgu-note' }, overview.note || t('officialNote')),
            hasNumbers ? null : h('div', { className: 'rgu-error', style: { marginTop: '8px' } }, t('officialNoFields')),
            overview.raw && !hasNumbers
              ? h('pre', { className: 'rgu-raw' }, JSON.stringify(overview.raw, null, 2))
              : null,
          )
        : h(Section, { title: t('logsTitle') }, h(LogTable, { logs: overview.logs, symbol, t }))

      return h(
        'div',
        { className: 'rgu-root' },
        h('style', null, CSS),
        h('div', { className: 'rgu-top' },
          h('div', { className: 'rgu-id' },
            h('span', { className: 'rgu-dot', 'data-state': busy ? 'busy' : error ? 'error' : 'ready' }),
            h('span', { className: 'rgu-name' }, t('title')),
            h('span', { className: 'rgu-sub' },
              `${(overview.station && overview.station.name) || t('stationFallback')} · ${hostOf(overview.station && overview.station.baseUrl)}${account.displayName ? ` · ${account.displayName}` : ''}`),
          ),
          h('div', { className: 'rgu-tools' },
            stations && stations.length > 1 ? h(StationChips, { stations, activeId, onSwitch }) : null,
            h('button', { className: 'rgu-btn', type: 'button', onClick: onRefresh, disabled: busy }, busy ? t('refreshing') : t('refresh')),
            h('button', { className: 'rgu-btn', type: 'button', onClick: onAdd }, t('addStation')),
            activeStation ? h('button', { className: 'rgu-btn', type: 'button', 'data-variant': 'ghost', onClick: () => onRemove(activeStation) }, t('remove')) : null,
            h('button', { className: 'rgu-btn', type: 'button', 'data-variant': 'ghost', onClick: onSignOut }, t('signOut')),
          ),
        ),
        error
          ? h('div', { className: 'rgu-error' },
              h('span', null, error),
              h('button', { className: 'rgu-btn', type: 'button', onClick: onRefresh, disabled: busy }, t('retry')),
            )
          : null,
        h('div', { className: 'rgu-cards' }, ...cards),
        h(TrendBlock, { days: week.days, symbol, t }),
        h('div', { className: 'rgu-split' },
          h(Section, {
            title: t('modelsTitle'),
            hint: models.length ? `${fmtInt(requestsTotal(models))} ${t('times')}` : undefined,
          }, h(ModelList, { models, symbol, t })),
          rightColumn,
        ),
        h('div', { className: 'rgu-foot' },
          h('span', null, `${t('updated')} ${fmtClock(overview.fetchedAt || Date.now())}`),
          h('span', null, t('autoRefresh')),
          overview.station && overview.station.version ? h('span', null, overview.station.version) : null,
        ),
      )
    }

    /** Total request count across model rows, used as the section hint. */
    function requestsTotal(models) {
      return (Array.isArray(models) ? models : []).reduce((sum, model) => sum + (Number(model.count) || 0), 0)
    }

    /* ------------------------------ panel ------------------------------ */

    function RelayPanel() {
      const t = useCallback((key, vars) => translate(activeDict(), key, vars), [])
      const [, bumpLocale] = useState(0)

      useEffect(() => {
        const watcher = () => bumpLocale((tick) => tick + 1)
        localeWatchers.add(watcher)
        return () => {
          localeWatchers.delete(watcher)
        }
      }, [])

      const [stations, setStations] = useState(() => {
        const stored = readStoreWithLegacy(STORE_STATIONS, LEGACY_KEYS.stations, [])
        return Array.isArray(stored) ? stored : []
      })
      const [activeId, setActiveId] = useState(() => {
        const stored = readStoreWithLegacy(STORE_ACTIVE, LEGACY_KEYS.active, '')
        return typeof stored === 'string' ? stored : ''
      })
      const [sessions, setSessions] = useState(() => {
        const stored = readStoreWithLegacy(STORE_SESSIONS, LEGACY_KEYS.sessions, {})
        return stored && typeof stored === 'object' ? stored : {}
      })
      const [overview, setOverview] = useState(null)
      const [status, setStatus] = useState('idle')
      const [error, setError] = useState('')
      const [editing, setEditing] = useState(false)
      const [resuming, setResuming] = useState(true)

      const busy = status === 'connecting' || status === 'refreshing'
      const stationsRef = useRef(stations)
      stationsRef.current = stations
      const sessionsRef = useRef(sessions)
      sessionsRef.current = sessions

      const rememberSession = (stationId, sessionId) => {
        const next = { ...sessionsRef.current, [stationId]: sessionId }
        setSessions(next)
        writeStore(STORE_SESSIONS, next)
      }

      const forgetSession = (stationId) => {
        const next = { ...sessionsRef.current }
        delete next[stationId]
        setSessions(next)
        writeStore(STORE_SESSIONS, next)
      }

      const connect = useCallback(async (input) => {
        setStatus('connecting')
        setError('')
        try {
          const result = await callHost({
            action: 'connect',
            baseUrl: input.baseUrl,
            username: input.username,
            password: input.password,
            token: input.token || '',
            provider: looksOfficial(input.baseUrl) ? 'deepseek' : '',
          })
          if (!result.ok) throw new Error(result.error || t('empty'))

          const base = String(input.baseUrl || '').trim() || DEFAULT_BASE
          const list = stationsRef.current
          const existing = list.find(
            (station) =>
              String(station.baseUrl).replace(/\/$/, '') === base.replace(/\/$/, '') &&
              (station.username || '') === (input.username || ''),
          )
          const record = {
            id: existing ? existing.id : newId(),
            label: (result.station && result.station.name) || hostOf(base),
            baseUrl: (result.station && result.station.baseUrl) || base,
            username: input.username || '',
            password: input.remember && !input.token ? input.password : '',
            token: input.remember && input.token ? input.token : '',
            remember: Boolean(input.remember),
          }
          const next = existing
            ? list.map((station) => (station.id === existing.id ? record : station))
            : [...list, record]
          setStations(next)
          writeStore(STORE_STATIONS, next)
          setActiveId(record.id)
          writeStore(STORE_ACTIVE, record.id)
          rememberSession(record.id, result.sessionId)
          setOverview(result.overview)
          setEditing(false)
          setStatus('ready')
        } catch (failure) {
          setStatus('error')
          setError(failure && failure.message ? failure.message : String(failure))
        }
      }, [t])

      const loadOverview = useCallback(async (stationId) => {
        const sessionId = sessionsRef.current[stationId]
        if (!sessionId) return false
        setStatus('refreshing')
        setError('')
        try {
          const result = await callHost({ action: 'overview', sessionId })
          if (result.ok) {
            setOverview(result.overview)
            setStatus('ready')
            return true
          }
          forgetSession(stationId)
          setStatus('idle')
          if (result.needsLogin) return false
          setOverview(null)
          setError(result.error || t('empty'))
          return false
        } catch (failure) {
          setStatus('error')
          setError(failure && failure.message ? failure.message : String(failure))
          return false
        }
      }, [t])

      const openStation = useCallback(async (station) => {
        if (!station) {
          setEditing(true)
          return
        }
        setActiveId(station.id)
        writeStore(STORE_ACTIVE, station.id)
        const loaded = await loadOverview(station.id)
        if (loaded) return
        if (station.password || station.token) {
          await connect({
            baseUrl: station.baseUrl,
            username: station.username,
            password: station.password || '',
            token: station.token || '',
            remember: station.remember !== false,
          })
          return
        }
        setOverview(null)
        setEditing(true)
      }, [connect, loadOverview])

      const refresh = useCallback(async () => {
        const station = stationsRef.current.find((item) => item.id === activeId)
        const loaded = await loadOverview(activeId)
        if (!loaded && station && (station.password || station.token)) await openStation(station)
      }, [activeId, loadOverview, openStation])

      const refreshRef = useRef(refresh)
      refreshRef.current = refresh

      const signOut = useCallback(async () => {
        const sessionId = sessionsRef.current[activeId]
        if (sessionId) {
          try {
            await callHost({ action: 'logout', sessionId })
          } catch {
            /* the local session is dropped regardless */
          }
        }
        forgetSession(activeId)
        setOverview(null)
        setStatus('idle')
        setEditing(true)
      }, [activeId])

      const removeStation = useCallback(async (station) => {
        const confirmText = translate(activeDict(), 'confirmRemove', { name: station.label || station.baseUrl })
        let approved = true
        try {
          approved = window.confirm(confirmText)
        } catch {
          approved = true
        }
        if (!approved) return

        const sessionId = sessionsRef.current[station.id]
        if (sessionId) {
          try {
            await callHost({ action: 'logout', sessionId })
          } catch {
            /* ignore */
          }
        }
        forgetSession(station.id)

        const next = stationsRef.current.filter((item) => item.id !== station.id)
        setStations(next)
        writeStore(STORE_STATIONS, next)
        if (station.id !== activeId) return

        setOverview(null)
        setStatus('idle')
        if (next[0]) {
          const fallback = next[0]
          setActiveId(fallback.id)
          writeStore(STORE_ACTIVE, fallback.id)
          await openStation(fallback)
        } else {
          setActiveId('')
          writeStore(STORE_ACTIVE, '')
          setEditing(true)
        }
      }, [activeId, openStation])

      /* Resume the previous session on mount so a page reload keeps you signed in. */
      useEffect(() => {
        const list = stationsRef.current
        const station = list.find((item) => item.id === activeId) || list[0]
        if (!station) {
          setEditing(true)
          /* Never leave the panel in its loading state when there is nothing to load. */
          setResuming(false)
          return undefined
        }

        let cancelled = false
        /* Safety net: a slow or hung station must not pin the panel on "loading". */
        const guard = window.setTimeout(() => {
          if (!cancelled) setResuming(false)
        }, 8000)

        ;(async () => {
          if (cancelled) return
          try {
            await openStation(station)
          } finally {
            if (!cancelled) {
              window.clearTimeout(guard)
              setResuming(false)
            }
          }
        })()

        return () => {
          cancelled = true
          window.clearTimeout(guard)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /* Keep the numbers fresh while the panel stays open. */
      useEffect(() => {
        const timer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          refreshRef.current()
        }, REFRESH_MS)
        return () => window.clearInterval(timer)
      }, [])

      if (resuming && !overview) {
        return h(
          'div',
          { className: 'rgu-root' },
          h('style', null, CSS),
          h('div', { className: 'rgu-section' },
            h('div', { className: 'rgu-empty' }, t('loading')),
            h('div', { style: { marginTop: '6px' } },
              h('button', {
                className: 'rgu-btn',
                type: 'button',
                onClick: () => {
                  setResuming(false)
                  setEditing(true)
                },
              }, t('addStation')),
            ),
          ),
        )
      }

      if (editing || !overview) {
        return h(
          'div',
          { className: 'rgu-root' },
          h('style', null, CSS),
          h(LoginCard, {
            t,
            stations,
            activeId,
            busy,
            error,
            initialBase: (stations[0] && stations[0].baseUrl) || DEFAULT_BASE,
            onCancel: overview || stations.length ? () => setEditing(false) : undefined,
            onSwitch: (station) => openStation(station),
            onSubmit: (input) => {
              if (!input.token && (!input.baseUrl || !input.username || !input.password)) {
                setError(t('errEmpty'))
                return
              }
              connect(input)
            },
          }),
        )
      }

      return h(Dashboard, {
        overview,
        stations,
        activeId,
        busy,
        error,
        t,
        onRefresh: () => refresh(),
        onAdd: () => setEditing(true),
        onSignOut: signOut,
        onRemove: removeStation,
        onSwitch: (station) => openStation(station),
      })
    }

    function NavIcon({ size, active }) {
      const edge = size || 16
      return h(
        'svg',
        { width: edge, height: edge, viewBox: '0 0 20 20', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M3.2 15.4h13.6M5.1 15.4V9.6m5 5.8V5.4m4.8 10V11',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2.1 : 1.7,
          strokeLinecap: 'round',
          opacity: active ? 1 : 0.82,
        }),
        h('circle', { cx: 15.1, cy: 5.4, r: 1.9, fill: 'currentColor', opacity: active ? 0.95 : 0.6 }),
      )
    }

    function createBoundary() {
      if (!React || typeof React.Component !== 'function') return (props) => props.children

      class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        componentDidCatch(error) {
          reportClientError('panel-boundary', error)
        }

        render() {
          if (this.state.error) {
            return h(
              'div',
              { className: 'rgu-root' },
              h('style', null, CSS),
              h('div', { className: 'rgu-error' },
                `中转站面板渲染出错：${this.state.error && this.state.error.message ? this.state.error.message : this.state.error}`),
            )
          }
          return this.props.children
        }
      }

      return (props) => h(PanelBoundary, null, props.children)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = (key, vars) => translate(activeDict(), key, vars)
        const Boundary = createBoundary()
        const PanelRoot = (props) => h(Boundary, null, h(RelayPanel, props))

        if (typeof ctx.on === 'function') {
          try {
            ctx.on('locale/change', notifyLocaleChange)
          } catch (error) {
            reportClientError('locale-hook', error)
          }
        }

        try {
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'relay', order: -10, label: () => t('nav') },
              NavIcon,
            ),
          )
        } catch (error) {
          reportClientError('register-panellist', error)
        }

        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'relay' }, PanelRoot),
          )
        } catch (error) {
          reportClientError('register-main', error)
        }
      },
      __test: { Dashboard, LoginCard, dict: DICT.zh, dictEn: DICT.en },
    }
  },
})