/**
 * Host half of the network-proxy toggle.
 *
 * It owns one runtime switch over the process-wide undici dispatcher and the proxy
 * environment that child processes inherit. The switch state lives in this plugin's
 * volatile configuration, so a change applies in place (no plugin restart) and survives
 * DSH restarts. Turning it off restores the dispatcher and environment the launcher had
 * installed, which is exactly the "follow the startup configuration" semantic.
 */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)

/**
 * The Desktop bundle keeps the shared Harness packages inside app.asar. A profile plugin
 * lives outside that tree, so the bare specifier cannot resolve; loading the exact file URL
 * also guarantees one module instance, which is what makes the shared proxy policy and the
 * global dispatcher consistent with the launcher.
 */
function harnessNodeModules() {
  const resources = process.resourcesPath ?? join(dirname(process.execPath), '..', 'Resources')
  return join(resources, 'app.asar', 'dsh', 'node_modules')
}

async function loadHarnessModule(parts, specifier) {
  const file = pathToFileURL(join(harnessNodeModules(), ...parts)).href
  try {
    return await import(file)
  } catch (error) {
    if (specifier === undefined) throw error
    return await import(specifier)
  }
}

const schemastery = await loadHarnessModule(
  ['@deepseek-ai', 'schemastery', 'lib', 'index.mjs'],
  '@deepseek-ai/schemastery',
)
const httpProxy = await loadHarnessModule(
  ['@deepseek-ai', 'dsh-http-proxy', 'lib', 'index.js'],
  '@deepseek-ai/dsh-http-proxy',
)
const undici = await loadHarnessModule(['undici', 'index.js'], 'undici')
const z = schemastery.default ?? schemastery
const { installProxyFromEnvironment } = httpProxy

/**
 * Google's connectivity endpoint. Unlike a plain 200 page it returns 204 with no body, and
 * unlike a China-reachable trace host it fails on a direct connection, so a success proves the
 * request really left through the configured proxy.
 */
const PROBE_URL = 'https://www.google.com/generate_204'
/** Loopback stays direct, matching the launcher's policy. */
const NO_PROXY = 'localhost,127.0.0.1,::1,[::1]'
/** How long one system-layer reading stays fresh while the UI polls. */
const SYSTEM_TTL_MS = 10_000
const DEFAULT_PROXY_URL = 'http://127.0.0.1:7897'

export const name = 'proxy-toggle'
export const inject = ['webServer']

export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  proxyUrl: z.string().default(DEFAULT_PROXY_URL).volatile(),
})

/** Read a volatile configuration reference, tolerating a plain value. */
function readRef(ref, fallback) {
  if (ref && typeof ref.get === 'function') {
    try {
      const value = ref.get()
      return value === undefined || value === null ? fallback : value
    } catch {
      return fallback
    }
  }
  return ref === undefined || ref === null ? fallback : ref
}

/** Accept only the HTTP(S) proxy URLs undici can route through. */
function validateProxyUrl(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return { ok: false, reason: 'empty' }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  return { ok: true, value: parsed.href }
}

/** Parse `scutil --proxy` into the three macOS proxy switches. */
function parseSystemProxy(text) {
  const fields = {}
  for (const line of String(text).split('\n')) {
    const match = /^\s*([A-Za-z0-9]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (match) fields[match[1]] = match[2]
  }
  const read = (prefix) => {
    const enabled = fields[`${prefix}Enable`] === '1'
    const host = fields[`${prefix}Proxy`]
    const port = fields[`${prefix}Port`]
    return {
      enabled,
      host: host === undefined || host === '' ? null : host,
      port: port === undefined || port === '' || !Number.isFinite(Number(port)) ? null : Number(port),
    }
  }
  return { http: read('HTTP'), https: read('HTTPS'), socks: read('SOCKS') }
}

/** Detect a TUN interface holding a default or split-default route. */
function parseTunRoute(text) {
  for (const line of String(text).split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 4) continue
    const [destination, , , netif] = columns
    if (!netif || !netif.startsWith('utun')) continue
    if (destination === 'default' || destination === '0/1' || destination === '128.0/1') {
      return { detected: true, via: netif, destination }
    }
  }
  return { detected: false, via: null, destination: null }
}

export function apply(ctx, config) {
  const enabledRef = config.enabled
  const proxyUrlRef = config.proxyUrl

  /** The installed overlay, `null` while the launcher policy is in charge. */
  let installed = null
  let probe = { state: 'idle' }
  let installError = null
  let disposed = false
  let queue = Promise.resolve()
  let systemCache = { at: 0, value: null, pending: null }

  const desired = () => ({
    enabled: Boolean(readRef(enabledRef, false)),
    url: String(readRef(proxyUrlRef, DEFAULT_PROXY_URL)),
  })

  /** Serialize every state transition so concurrent UI clicks cannot interleave. */
  function serial(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function install(url) {
    const env = {
      get(variable) {
        if (variable === 'http_proxy' || variable === 'https_proxy') return { value: url }
        if (variable === 'no_proxy') return { value: NO_PROXY }
        return undefined
      },
    }
    const dispose = await installProxyFromEnvironment(env, (message) => {
      ctx.logger?.warn?.(`[proxy-toggle] ${message}`)
    })
    installed = { url, dispose }
    installError = null
  }

  async function uninstall() {
    const current = installed
    installed = null
    if (!current) return
    try {
      await current.dispose()
    } catch (error) {
      ctx.logger?.warn?.(`[proxy-toggle] restoring the startup policy failed: ${String(error)}`)
    }
  }

  /** Make the runtime match one desired state. */
  async function applyRuntime(want) {
    if (!want.enabled) {
      await uninstall()
      probe = { state: 'idle' }
      return
    }
    const validation = validateProxyUrl(want.url)
    if (!validation.ok) {
      await uninstall()
      installError = 'invalid_proxy_url'
      probe = { state: 'error', error: 'invalid_proxy_url', at: Date.now() }
      return
    }
    if (installed && installed.url !== validation.value) await uninstall()
    if (installed) return
    try {
      await install(validation.value)
    } catch (error) {
      installError = String(error?.message ?? error)
      probe = { state: 'error', error: installError, at: Date.now() }
    }
  }

  async function reconcile() {
    if (disposed) return
    await applyRuntime(desired())
  }

  /** Send one probe request and normalize its status. */
  async function probeOnce() {
    const response = await undici.fetch(PROBE_URL, {
      method: 'GET',
      headers: { 'user-agent': 'dsh-proxy-toggle/1.0' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel?.()
    if (response.status !== 204 && (response.status < 200 || response.status >= 400)) {
      throw new Error(`HTTP ${response.status}`)
    }
    return response.status
  }

  /** Probe through the installed dispatcher, retrying once so one handshake blip is not red. */
  async function runProbe() {
    const current = installed
    if (!current) {
      probe = { state: 'idle' }
      return
    }
    probe = { state: 'checking', at: Date.now() }
    const started = Date.now()
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700))
      if (installed !== current || disposed) return
      try {
        const status = await probeOnce()
        if (installed !== current || disposed) return
        probe = { state: 'ok', status, ms: Date.now() - started, at: Date.now() }
        return
      } catch (error) {
        lastError = error
      }
    }
    if (installed !== current || disposed) return
    const cause = lastError?.cause?.message ?? lastError?.cause?.code
    probe = {
      state: 'error',
      error: cause ? `${String(lastError?.message ?? lastError)} (${cause})` : String(lastError?.message ?? lastError),
      ms: Date.now() - started,
      at: Date.now(),
    }
  }

  async function readSystem() {
    const [scutil, netstat] = await Promise.all([
      execFileAsync('/usr/sbin/scutil', ['--proxy'], { timeout: 4000 })
        .then((result) => result.stdout)
        .catch(() => ''),
      execFileAsync('/usr/sbin/netstat', ['-rn', '-f', 'inet'], { timeout: 4000 })
        .then((result) => result.stdout)
        .catch(() => ''),
    ])
    return {
      platform: process.platform,
      proxy: parseSystemProxy(scutil),
      tun: parseTunRoute(netstat),
      checkedAt: Date.now(),
    }
  }

  /** Read the system layer at most once per TTL so UI polling stays cheap. */
  function systemInfo() {
    const now = Date.now()
    if (systemCache.value && now - systemCache.at < SYSTEM_TTL_MS) return Promise.resolve(systemCache.value)
    if (systemCache.pending) return systemCache.pending
    const pending = readSystem()
      .then((value) => {
        systemCache = { at: Date.now(), value, pending: null }
        return value
      })
      .catch((error) => {
        const value = { platform: process.platform, error: String(error?.message ?? error), checkedAt: Date.now() }
        systemCache = { at: 0, value, pending: null }
        return value
      })
    systemCache = { ...systemCache, pending }
    return pending
  }

  async function buildState() {
    const want = desired()
    const validation = validateProxyUrl(want.url)
    const system = await systemInfo()
    return {
      enabled: want.enabled,
      proxyUrl: want.url,
      proxyUrlValid: validation.ok,
      installed: installed !== null,
      installedUrl: installed?.url ?? null,
      installError,
      probe,
      system,
      updatedAt: Date.now(),
    }
  }

  /** Persist a field into this plugin's own profile row. */
  async function persist(patch) {
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (!entry || !editor) return { persisted: false, reason: 'config_editor_unavailable' }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...patch }))
      return { persisted: true }
    } catch (error) {
      return { persisted: false, reason: String(error?.message ?? error) }
    }
  }

  async function setEnabled(enabled) {
    if (enabled) {
      const validation = validateProxyUrl(desired().url)
      if (!validation.ok) throw new Error('invalid_proxy_url')
    }
    let warning
    await serial(async () => {
      await applyRuntime({ enabled, url: desired().url })
      const saved = await persist({ enabled })
      if (!saved.persisted) warning = saved.reason
    })
    if (enabled) void serial(runProbe)
    return { warning }
  }

  async function setUrl(raw) {
    const validation = validateProxyUrl(raw)
    if (!validation.ok) throw new Error('invalid_proxy_url')
    const value = String(raw).trim()
    let warning
    await serial(async () => {
      const want = desired()
      await applyRuntime({ enabled: want.enabled, url: value })
      const saved = await persist({ proxyUrl: value })
      if (!saved.persisted) warning = saved.reason
    })
    if (desired().enabled) void serial(runProbe)
    return { warning }
  }

  async function handleAction(payload) {
    const action = payload?.action
    if (action === 'setEnabled') return await setEnabled(Boolean(payload.enabled))
    if (action === 'setUrl') return await setUrl(String(payload.url ?? ''))
    if (action === 'probe') {
      await serial(runProbe)
      return {}
    }
    if (action === 'refreshSystem') {
      systemCache = { at: 0, value: systemCache.value, pending: null }
      return {}
    }
    throw new Error('unknown_action')
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  function isOwner(peer) {
    return peer === undefined || peer?.principal?.kind === 'owner'
  }

  async function stateResource(request, peer) {
    if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!isOwner(peer)) return json({ ok: false, error: 'forbidden' }, 403)
    return json({ ok: true, state: await buildState() })
  }

  function sendJson(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }

  function actionHandler(request, response) {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
      response.end('method not allowed')
      return
    }
    let body = ''
    let tooLarge = false
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      if (tooLarge) return
      body += chunk
      if (body.length > 4096) {
        tooLarge = true
        sendJson(response, 413, { ok: false, error: 'payload_too_large' })
      }
    })
    request.on('end', async () => {
      if (tooLarge) return
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch {
        sendJson(response, 400, { ok: false, error: 'invalid_json' })
        return
      }
      try {
        const result = await handleAction(payload)
        sendJson(response, 200, { ok: true, state: await buildState(), warning: result?.warning })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
      }
    })
    request.on('error', () => {
      try {
        response.destroy()
      } catch {}
    })
  }

  ctx.effect(() => {
    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: '/plugin/proxy-toggle/state',
      resource: stateResource,
    })
    const disposeAction = ctx.webServer.register({
      kind: 'exact',
      path: '/plugin/proxy-toggle/action',
      handler: actionHandler,
    })
    return () => {
      disposeState()
      disposeAction()
    }
  })

  // Volatile-only edits (this plugin's UI or a settings form) update in place and emit this.
  ctx.on('loader/volatile-update', () => {
    void serial(reconcile)
  })

  ctx.effect(() => () => {
    disposed = true
    return uninstall()
  })

  void serial(async () => {
    await reconcile()
    if (desired().enabled) await runProbe()
  })
}
