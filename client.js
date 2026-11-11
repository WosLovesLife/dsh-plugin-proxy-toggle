/**
 * Client half of the network-proxy toggle: the sidebar switch and the settings page.
 *
 * Both views read one small store that polls the Host's local HTTP route, so they stay
 * consistent without a second transport.
 */
const CSS = `
.dsh-proxy-action { display:flex; align-items:center; gap:8px; height:32px; padding:0 10px; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; cursor:pointer; width:100%; text-align:left; transition:background 120ms ease,color 120ms ease; }
.dsh-proxy-action:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.dsh-proxy-action[data-wide="false"] { width:32px; padding:0; justify-content:center; }
.dsh-proxy-action:disabled { cursor:default; opacity:.6; }
.dsh-proxy-action-icon { display:inline-flex; flex:none; }
.dsh-proxy-action-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-proxy-spacer { flex:1 1 auto; }
.dsh-proxy-dot { width:7px; height:7px; border-radius:50%; flex:none; }

.dsh-proxy-page { display:flex; flex-direction:column; gap:16px; padding:8px 4px 32px; max-width:720px; color:var(--dsw-alias-label-primary); }
.dsh-proxy-head { display:flex; flex-direction:column; gap:4px; }
.dsh-proxy-head h2 { margin:0; font-size:18px; font-weight:600; }
.dsh-proxy-head p { margin:0; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:1.55; }
.dsh-proxy-card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:10px; }
.dsh-proxy-row { display:flex; align-items:center; gap:12px; }
.dsh-proxy-row-label { font-size:13px; font-weight:500; }
.dsh-proxy-hint { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.55; }
.dsh-proxy-banner { border-radius:8px; padding:8px 10px; font-size:12px; line-height:1.5; border:1px solid var(--dsw-alias-border-l1); }
.dsh-proxy-banner[data-tone="error"] { color:var(--dsw-alias-state-error-primary); border-color:currentColor; }
.dsh-proxy-banner[data-tone="warn"] { color:var(--dsw-alias-state-warn-primary); border-color:currentColor; }
.dsh-proxy-kv { display:flex; justify-content:space-between; gap:16px; font-size:13px; }
.dsh-proxy-kv span:first-child { color:var(--dsw-alias-label-secondary); }
.dsh-proxy-kv span:last-child { text-align:right; word-break:break-all; }
.dsh-proxy-chips { display:flex; gap:6px; flex-wrap:wrap; }
.dsh-proxy-chip { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.dsh-proxy-chip[data-on="true"] { color:var(--dsw-alias-state-success-primary); border-color:currentColor; }

.dsh-proxy-switch { position:relative; width:38px; height:22px; border-radius:11px; border:0; padding:0; cursor:pointer; background:var(--dsw-alias-border-l2); transition:background 120ms ease; flex:none; }
.dsh-proxy-switch[data-on="true"] { background:var(--dsw-alias-brand-primary); }
.dsh-proxy-switch::after { content:""; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform 120ms ease; }
.dsh-proxy-switch[data-on="true"]::after { transform:translateX(16px); }
.dsh-proxy-switch:disabled { opacity:.55; cursor:default; }

.dsh-proxy-input { flex:1 1 auto; height:32px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); padding:0 10px; font:inherit; font-size:13px; min-width:0; }
.dsh-proxy-input:focus { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-1px; }
.dsh-proxy-button { height:32px; padding:0 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; cursor:pointer; flex:none; }
.dsh-proxy-button:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.dsh-proxy-button:disabled { opacity:.55; cursor:default; }
`


window.__ModuleLoader__.load({
  id: 'dsh-plugin-proxy-toggle',
  factory(require) {
    const React = require('react')
    const { useEffect, useState, useSyncExternalStore } = React
    const h = React.createElement

    const API = '/plugin/proxy-toggle'
    const POLL_MS = 5000

    const TONE = {
      idle: 'var(--dsw-alias-state-idle-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    const DICT = {
      en: {
        title: 'Network proxy',
        stateOn: 'On',
        stateOff: 'Off',
        pageTitle: 'Network proxy',
        pageDesc:
          'Route DeepSeek Harness outbound traffic through a local HTTP proxy. The switch lives in your profile and survives a restart.',
        enableLabel: 'Proxy switch',
        enableHintOn: 'On: every outbound request, including bash child processes, uses {url}.',
        enableHintOff: 'Off: Harness follows the proxy configuration captured at startup.',
        addressLabel: 'Proxy address',
        addressPlaceholder: 'http://127.0.0.1:7897',
        addressHint: 'HTTP or HTTPS proxy only. SOCKS is rejected because the transport does not support it.',
        save: 'Save',
        test: 'Test now',
        lastCheck: 'Last check',
        probeOk: 'Reachable',
        probeError: 'Unreachable',
        probeIdle: 'Not checked yet',
        checking: 'Checking…',
        systemTitle: 'System layer (read-only)',
        systemProxy: 'macOS system proxy',
        systemProxyOff: 'All off',
        tun: 'TUN takeover',
        tunOn: 'Detected on {iface}; turning the switch off may still send traffic through Clash.',
        tunOff: 'No TUN default route detected.',
        followStartup:
          'Turning the switch off restores the startup proxy configuration. If ~/.dsh/.env defines a proxy, traffic keeps using it.',
        persistFailed: 'Applied at runtime, but saving to the profile failed: {reason}',
        invalidUrl: 'Enter a valid http:// or https:// proxy address.',
        requestFailed: 'Request failed: {error}',
        unknown: 'Unknown',
        on: 'on',
        off: 'off',
      },
      zh: {
        title: '网络代理',
        stateOn: '已开启',
        stateOff: '已关闭',
        pageTitle: '网络代理',
        pageDesc: '控制 DeepSeek Harness 的出站流量是否经过本地 HTTP 代理。开关状态保存在配置里，重启后恢复。',
        enableLabel: '代理开关',
        enableHintOn: '已开启：所有出站请求（含 bash 子进程）经 {url}。',
        enableHintOff: '已关闭：Harness 跟随启动时捕获的代理配置。',
        addressLabel: '代理地址',
        addressPlaceholder: 'http://127.0.0.1:7897',
        addressHint: '仅支持 HTTP/HTTPS 代理；SOCKS 会被拒绝，因为传输层不支持。',
        save: '保存',
        test: '立即测试',
        lastCheck: '最近检查',
        probeOk: '可连通',
        probeError: '不可用',
        probeIdle: '尚未检查',
        checking: '测试中…',
        systemTitle: '系统层（只读）',
        systemProxy: 'macOS 系统代理',
        systemProxyOff: '全部关闭',
        tun: 'TUN 接管',
        tunOn: '检测到 {iface} 在接管流量；关掉开关后仍可能经 Clash 出网。',
        tunOff: '未检测到 TUN 默认路由。',
        followStartup: '关闭只恢复启动时的代理配置；如果 ~/.dsh/.env 写有代理，关闭后仍会使用它。',
        persistFailed: '已在运行时生效，但写入 profile 失败：{reason}',
        invalidUrl: '请输入有效的 http:// 或 https:// 代理地址。',
        requestFailed: '请求失败：{error}',
        unknown: '未知',
        on: '开',
        off: '关',
      },
    }

    let face = null
    let translate = (key) => key
    const listeners = new Set()
    let timer = null
    let snapshot = { loading: true, busy: false, data: null, error: null, warning: null }

    function emit() {
      for (const listener of [...listeners]) listener()
    }

    function patch(next) {
      snapshot = { ...snapshot, ...next }
      emit()
    }

    function subscribe(listener) {
      listeners.add(listener)
      if (!timer) {
        void refresh()
        timer = setInterval(() => {
          void refresh()
        }, POLL_MS)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size && timer) {
          clearInterval(timer)
          timer = null
        }
      }
    }

    function getSnapshot() {
      return snapshot
    }

    async function refresh() {
      try {
        const response = await fetch(`${API}/state`, { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        patch({ loading: false, data: body.state, error: null })
      } catch (error) {
        patch({ loading: false, error: String(error?.message ?? error) })
      }
    }

    async function act(payload) {
      if (snapshot.busy) return
      patch({ busy: true, warning: null })
      try {
        const response = await fetch(`${API}/action`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
        patch({ busy: false, data: body.state, error: null, warning: body.warning ?? null })
        setTimeout(() => {
          void refresh()
        }, 800)
        setTimeout(() => {
          void refresh()
        }, 3000)
      } catch (error) {
        patch({ busy: false, error: String(error?.message ?? error) })
      }
    }

    function tr(key, vars) {
      let text = translate(key)
      if (vars) {
        for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
      }
      return text
    }

    function useLocaleTick() {
      const [, force] = useState(0)
      useEffect(() => {
        if (!face) return undefined
        return face.subscribe(() => force((value) => value + 1))
      }, [])
    }

    function toneOf(data) {
      if (!data || !data.enabled) return 'idle'
      if (data.probe?.state === 'error' || data.installError) return 'error'
      if (data.probe?.state === 'ok') return 'ok'
      return 'warn'
    }

    function Glyph({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('ellipse', { cx: 12, cy: 12, rx: 3.8, ry: 8.5, stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.85 }),
        h('path', {
          d: 'M3.5 12h17M5 7.5h14M5 16.5h14',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          opacity: 0.85,
        }),
      )
    }

    function Style() {
      return h('style', null, CSS)
    }

    function ProxyAction(props) {
      useLocaleTick()
      const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const data = state.data
      const enabled = data?.enabled === true
      const tone = toneOf(data)
      const label = enabled ? tr('stateOn') : tr('stateOff')
      const title = data
        ? `${tr('title')} · ${label}${enabled && data.proxyUrl ? ` · ${data.proxyUrl}` : ''}`
        : tr('title')
      return h(
        React.Fragment,
        null,
        h(Style, { key: 'style' }),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'dsh-proxy-action',
            'data-wide': props.wide ? 'true' : 'false',
            'data-tone': tone,
            disabled: state.busy,
            title,
            'aria-label': title,
            'aria-pressed': enabled,
            onClick: () => {
              void act({ action: 'setEnabled', enabled: !enabled })
            },
          },
          h('span', { className: 'dsh-proxy-action-icon' }, h(Glyph, null)),
          props.wide ? h('span', { className: 'dsh-proxy-action-label' }, label) : null,
          props.wide ? h('span', { className: 'dsh-proxy-spacer' }) : null,
          h('span', { className: 'dsh-proxy-dot', style: { background: TONE[tone] } }),
        ),
      )
    }

    function endpointText(entry) {
      if (!entry || !entry.enabled) return null
      const host = entry.host ?? '127.0.0.1'
      return entry.port ? `${host}:${entry.port}` : host
    }

    function SettingsPage() {
      useLocaleTick()
      const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const data = state.data
      const [draft, setDraft] = useState('')
      const [dirty, setDirty] = useState(false)

      useEffect(() => {
        if (!dirty && data?.proxyUrl) setDraft(data.proxyUrl)
      }, [data?.proxyUrl, dirty])

      const enabled = data?.enabled === true
      const probe = data?.probe ?? { state: 'idle' }
      const system = data?.system
      const http = endpointText(system?.proxy?.http)
      const https = endpointText(system?.proxy?.https)
      const socks = endpointText(system?.proxy?.socks)
      const anySystemProxy = Boolean(http || https || socks)

      let probeDetail = tr('probeIdle')
      if (probe.state === 'checking') probeDetail = tr('checking')
      else if (probe.state === 'error') probeDetail = `${tr('probeError')}: ${probe.error ?? tr('unknown')}`
      else if (probe.state === 'ok') {
        probeDetail = [tr('probeOk'), probe.status ? String(probe.status) : null, typeof probe.ms === 'number' ? `${probe.ms} ms` : null]
          .filter(Boolean)
          .join(' · ')
      }

      const warning = state.warning ? tr('persistFailed', { reason: state.warning }) : null

      return h(
        'section',
        { className: 'dsh-proxy-page' },
        h(Style, { key: 'style' }),
        h(
          'header',
          { className: 'dsh-proxy-head', key: 'head' },
          h('h2', null, tr('pageTitle')),
          h('p', null, tr('pageDesc')),
        ),

        state.error
          ? h('div', { className: 'dsh-proxy-banner', 'data-tone': 'error', key: 'error' }, tr('requestFailed', { error: state.error }))
          : null,
        warning ? h('div', { className: 'dsh-proxy-banner', 'data-tone': 'warn', key: 'warning' }, warning) : null,

        h(
          'div',
          { className: 'dsh-proxy-card', key: 'switch' },
          h(
            'div',
            { className: 'dsh-proxy-row' },
            h('span', { className: 'dsh-proxy-row-label' }, tr('enableLabel')),
            h('span', { className: 'dsh-proxy-spacer' }),
            h('span', {
              className: 'dsh-proxy-dot',
              style: { background: TONE[toneOf(data)] },
            }),
            h('button', {
              type: 'button',
              className: 'dsh-proxy-switch',
              role: 'switch',
              'aria-checked': enabled,
              'aria-label': tr('enableLabel'),
              'data-on': enabled ? 'true' : 'false',
              disabled: state.busy,
              onClick: () => {
                void act({ action: 'setEnabled', enabled: !enabled })
              },
            }),
          ),
          h(
            'p',
            { className: 'dsh-proxy-hint' },
            enabled ? tr('enableHintOn', { url: data?.installedUrl ?? data?.proxyUrl ?? '' }) : tr('enableHintOff'),
          ),
        ),

        h(
          'div',
          { className: 'dsh-proxy-card', key: 'address' },
          h('span', { className: 'dsh-proxy-row-label' }, tr('addressLabel')),
          h(
            'div',
            { className: 'dsh-proxy-row' },
            h('input', {
              className: 'dsh-proxy-input',
              type: 'text',
              inputMode: 'url',
              spellCheck: false,
              value: draft,
              placeholder: tr('addressPlaceholder'),
              'aria-label': tr('addressLabel'),
              disabled: state.busy,
              onChange: (event) => {
                setDraft(event.target.value)
                setDirty(true)
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter' && dirty) {
                  void act({ action: 'setUrl', url: draft })
                  setDirty(false)
                }
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-proxy-button',
                disabled: state.busy || !dirty,
                onClick: () => {
                  void act({ action: 'setUrl', url: draft })
                  setDirty(false)
                },
              },
              tr('save'),
            ),
          ),
          h('p', { className: 'dsh-proxy-hint' }, tr('addressHint')),
        ),

        h(
          'div',
          { className: 'dsh-proxy-card', key: 'probe' },
          h(
            'div',
            { className: 'dsh-proxy-kv' },
            h('span', null, tr('lastCheck')),
            h('span', null, probeDetail),
          ),
          h(
            'div',
            { className: 'dsh-proxy-row' },
            h('span', { className: 'dsh-proxy-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-proxy-button',
                disabled: state.busy || !enabled,
                onClick: () => {
                  void act({ action: 'probe' })
                },
              },
              tr('test'),
            ),
          ),
        ),

        h(
          'div',
          { className: 'dsh-proxy-card', key: 'system' },
          h('span', { className: 'dsh-proxy-row-label' }, tr('systemTitle')),
          h(
            'div',
            { className: 'dsh-proxy-chips' },
            h('span', { className: 'dsh-proxy-chip', 'data-on': http ? 'true' : 'false' }, `HTTP ${http ?? tr('off')}`),
            h('span', { className: 'dsh-proxy-chip', 'data-on': https ? 'true' : 'false' }, `HTTPS ${https ?? tr('off')}`),
            h('span', { className: 'dsh-proxy-chip', 'data-on': socks ? 'true' : 'false' }, `SOCKS ${socks ?? tr('off')}`),
          ),
          h(
            'p',
            { className: 'dsh-proxy-hint' },
            anySystemProxy ? tr('systemProxy') : `${tr('systemProxy')}: ${tr('systemProxyOff')}`,
          ),
          h(
            'p',
            { className: 'dsh-proxy-hint', key: 'tun' },
            system?.tun?.detected ? tr('tunOn', { iface: system.tun.via }) : tr('tunOff'),
          ),
          h('p', { className: 'dsh-proxy-hint', key: 'follow' }, tr('followStartup')),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('proxy-toggle', 'en', DICT.en))
      ctx.effect(() => ctx.locale.register('proxy-toggle', 'zh', DICT.zh))
      ctx.effect(() => ctx.locale.register('proxy-toggle', 'zh-CN', DICT.zh))
      face = ctx.locale
      translate = ctx.locale.bind('proxy-toggle')

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'proxy-toggle',
            order: -5,
            label: () => tr('title'),
          },
          ProxyAction,
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'proxy-toggle',
            order: 12,
            label: () => tr('title'),
          },
          SettingsPage,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
