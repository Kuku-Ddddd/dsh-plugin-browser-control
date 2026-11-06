import { defineTool } from './define-tool.js'

/**
 * Agent control over the DSH built-in browser (right Sidebar `browser` tabs).
 *
 * The shipped sidebar-browser package is presentation-only: no tool, and page
 * content never reaches the model. This plugin supplies the missing half.
 *
 * Topology: commands go Host -> page over an HTTP route the page long-polls
 * (same origin, authenticated session — the pattern `dsh-host-open-in-app`
 * uses), results come back on the POST. The page does the `<webview>` work and
 * returns plain JSON. Screenshots are admitted into the `attachments` store so
 * image bytes stay out of the transcript's text blocks.
 */

export const name = 'browser-control'

export const inject = ['tools', 'webServer', 'connection']

const ROUTE_NEXT = '/browser-control/next'
const ROUTE_RESULT = '/browser-control/result'
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const ACTIONS = ['open', 'navigate', 'back', 'forward', 'reload', 'read', 'evaluate', 'screenshot', 'status', 'click', 'fill', 'hover', 'press', 'list']

/** Pending FIFO plus the result rendezvous for one Host process. */
class Bus {
  constructor(config) {
    this.config = config
    this.seq = 0
    this.queue = []
    this.inflight = new Map()
    this.settlers = new Map()
    this.waiters = new Set()
    this.lastClaimAt = 0
  }

  get freshClaim() {
    return this.lastClaimAt > 0 && Date.now() - this.lastClaimAt < this.config.claimWaitMs + 15000
  }

  /** Submit one command and await the page result for it. */
  dispatch(command, signal) {
    const id = `cmd-${String(++this.seq)}`
    const entry = { id, ...command, submittedAt: Date.now() }
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.#drop(id)
        reject(new Error(`browser command "${id}" timed out after ${String(this.config.commandTimeoutMs)} ms (${pageHint(this)})`))
      }, this.config.commandTimeoutMs)
      const settle = (fn) => (value) => {
        clearTimeout(deadline)
        signal.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        this.#drop(id)
        reject(new Error('browser command was cancelled'))
      }
      this.settlers.set(id, { resolve: settle(resolve), reject: settle(reject) })
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
      this.#wake()
    })
  }

  /** Pop one queued command for a polling page, or park the claim. */
  claim(wait, respond) {
    this.lastClaimAt = Date.now()
    const command = this.queue.shift()
    if (command !== undefined) {
      this.inflight.set(command.id, command)
      respond(command)
      return () => {}
    }
    if (!wait) {
      respond(null)
      return () => {}
    }
    const holder = { respond, timer: setTimeout(() => this.#expire(holder), Math.max(1000, this.config.claimWaitMs)) }
    this.waiters.add(holder)
    // The polling page went away: drop the parked claim without answering it.
    return () => { this.waiters.delete(holder); clearTimeout(holder.timer) }
  }

  #expire(holder) {
    if (!this.waiters.delete(holder)) return
    holder.respond(null)
  }

  /** Record the page result for one in-flight command. */
  complete(id, payload) {
    const command = this.inflight.get(id)
    if (command === undefined) return false
    this.inflight.delete(id)
    const settler = this.settlers.get(id)
    this.settlers.delete(id)
    if (settler === undefined) return true
    if (payload.ok === true) settler.resolve(payload.value)
    else settler.reject(new Error(String(payload.error ?? 'the page failed the command without a reason')))
    return true
  }

  #wake() {
    for (const holder of this.waiters) {
      const command = this.queue.shift()
      if (command === undefined) return
      clearTimeout(holder.timer)
      this.waiters.delete(holder)
      this.inflight.set(command.id, command)
      holder.respond(command)
    }
  }

  #drop(id) {
    this.queue = this.queue.filter((entry) => entry.id !== id)
    this.inflight.delete(id)
    this.settlers.delete(id)
  }
}

function pageHint(bus) {
  return bus.freshClaim
    ? 'the browser page claimed work but never answered; the tab may be busy or the guest may have refused the command'
    : 'no browser-capable page is connected to this Host: open the app window and keep its right Sidebar running'
}

/** Validate an address the same way the shipped browser toolbar restricts it. */
function parseAddress(raw, appOrigin) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return { ok: false, reason: 'url is empty' }
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
  } catch {
    return { ok: false, reason: `not a parsable address: ${text}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `only HTTP(S) is allowed, got ${url.protocol}` }
  if (url.username.length > 0 || url.password.length > 0) return { ok: false, reason: 'credentials in the URL are not allowed' }
  // The shipped browser refuses the app's own origin; keep that rule so a
  // command can never load the harness inside the controlled guest.
  if (appOrigin !== undefined && url.origin === appOrigin) return { ok: false, reason: 'the DSH app origin itself is not a valid target' }
  return { ok: true, url: url.href }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload ?? null))
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Admit one base64 screenshot into the durable attachment store.
 * Mirrors the MCP image path: prove the active route accepts images first,
 * then hand the bytes over, and project the reference for the model.
 */
async function admitImage(ctx, exec, mimeType, data) {
  const buffer = Buffer.from(String(data), 'base64')
  if (buffer.toString('base64') !== String(data)) return { ok: false, reason: 'screenshot data was not canonical base64' }
  if (!IMAGE_MEDIA_TYPES.includes(mimeType)) return { ok: false, reason: `unsupported screenshot media type ${String(mimeType)}` }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return { ok: false, reason: 'no attachment store is mounted' }
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return { ok: false, reason: 'the current model route could not be resolved' }
  let info
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    return { ok: false, reason: 'the current model route could not be verified' }
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    return { ok: false, reason: `model "${model}" does not declare image input` }
  }
  if (exec.signal.aborted) return { ok: false, reason: 'the tool call was cancelled before image storage' }
  try {
    const refs = await attachments.saveImages([{ data: buffer, mediaType: mimeType }])
    return { ok: true, attachment: refs[0] }
  } catch (error) {
    return { ok: false, reason: `durable image storage rejected the result: ${String(error instanceof Error ? error.message : error)}` }
  }
}

export function apply(ctx, _rawConfig) {
  const config = {
    commandTimeoutMs: 30000,
    claimWaitMs: 20000,
    maxReadChars: 20000,
  }
  const bus = new Bus(config)
  /** Read the app origin lazily: by the time a tool call runs, the listener is bound. */
  const appOrigin = () => {
    try {
      return new URL(ctx.webServer.getOrigin()).origin
    } catch {
      return undefined
    }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'browser_control',
    description:
      'Drive the built-in browser tab of this app (right Sidebar "Browser"). '
      + 'Actions: open, navigate, back, forward, reload, read (text + title + url + links), '
      + 'evaluate (an async function body run in the page), click / fill / hover / press '
      + '(CSS selector, React/Vue-safe value writes, full pointer+mouse chain), '
      + 'screenshot (PNG the model can see), status, list (every tab with its index; '
      + 'pass tab to target one). '
      + 'It drives the tab the user can see, not a separate headless browser, so it needs a live '
      + 'app window — otherwise the call fails and says why.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'What to do.' },
      tab: { type: 'number', description: 'Which browser tab (index from action "list"). Defaults to the visible one.' },
      url: { type: 'string', description: 'HTTP(S) address for open/navigate. A bare host gets https://.' },
      script: { type: 'string', description: 'For evaluate: an async function body run in the page; return JSON.' },
      selector: { type: 'string', description: 'For click/fill/hover/press: CSS selector, first hit. Optional for press (defaults to the focused element).' },
      value: { type: 'string', description: 'For fill: the text to write (or an option value/text for a <select>).' },
      key: { type: 'string', description: 'For press: KeyboardEvent key, e.g. "Enter", "Tab", "Escape", "a". Defaults to "Enter".' },
      maxChars: { type: 'number', description: `For read: cap the returned text (default ${String(config.maxReadChars)}).` },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const blocks = []
        if (value.image !== undefined) {
          blocks.push(value.image.attachment !== undefined
            ? { type: 'image', attachment: value.image.attachment }
            : { type: 'text', text: `[image unavailable: ${String(value.image.mimeType ?? 'unknown')}; ${String(value.image.reason)}]` })
        }
        const summary = { ...value }
        delete summary.image
        blocks.push({ type: 'text', text: JSON.stringify(summary, null, 2) })
        return blocks
      },
    },
    async execute(args, exec) {
      const command = { action: args.action }
      if (args.tab !== undefined) {
        if (!Number.isInteger(args.tab) || args.tab < 0) throw new Error('tab must be a non-negative integer (see action "list")')
        command.tab = args.tab
      }
      if (args.url !== undefined) {
        const parsed = parseAddress(args.url, appOrigin())
        if (!parsed.ok) throw new Error(parsed.reason)
        command.url = parsed.url
      }
      if ((args.action === 'open' || args.action === 'navigate') && command.url === undefined) {
        throw new Error(`${args.action} needs a url`)
      }
      if (args.action === 'evaluate') {
        if (typeof args.script !== 'string' || args.script.trim().length === 0) throw new Error('evaluate needs a script body')
        command.script = args.script
      }
      if (args.action === 'read') command.maxChars = clampInt(args.maxChars, 200, config.maxReadChars)
      if (['click', 'fill', 'hover', 'press'].includes(args.action)) {
        if (args.selector !== undefined) {
          if (typeof args.selector !== 'string' || args.selector.trim().length === 0) throw new Error('selector must be a non-empty CSS selector')
          command.selector = args.selector
        } else if (args.action !== 'press') {
          throw new Error(`${args.action} needs a selector`)
        }
        if (args.action === 'fill') {
          if (typeof args.value !== 'string') throw new Error('fill needs a value (the text to write)')
          command.value = args.value
        }
        if (args.action === 'press') command.key = typeof args.key === 'string' && args.key.length > 0 ? args.key : 'Enter'
      }

      const value = await bus.dispatch(command, exec.signal)
      if (typeof value !== 'object' || value === null) return { action: args.action, result: value }
      const result = { action: args.action, ...value }
      if (Array.isArray(value.contentParts)) {
        const first = value.contentParts[0]
        if (first !== undefined && typeof first.mimeType === 'string' && typeof first.base64 === 'string') {
          const admitted = await admitImage(ctx, exec, first.mimeType, first.base64)
          result.image = admitted.ok ? { attachment: admitted.attachment } : { reason: admitted.reason, mimeType: first.mimeType }
        }
        delete result.contentParts
      }
      return result
    },
  })), 'browser-control: tool')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_NEXT,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'GET only' })
        return
      }
      const params = new URL(String(req.url), 'http://localhost').searchParams
      const wait = params.get('wait') !== '0'
      const release = bus.claim(wait, (command) => {
        if (res.writableEnded || res.destroyed) return
        sendJson(res, 200, command)
      })
      res.once('close', release)
    },
  }), `browser-control: GET ${ROUTE_NEXT}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_RESULT,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' })
        return
      }
      if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { error: 'content-type must be application/json' })
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req, 32 * 1024 * 1024))
      } catch (error) {
        sendJson(res, 400, { error: `bad body: ${String(error instanceof Error ? error.message : error)}` })
        return
      }
      if (typeof payload?.id !== 'string') {
        sendJson(res, 400, { error: 'id is required' })
        return
      }
      const known = bus.complete(payload.id, payload)
      sendJson(res, known ? 200 : 404, { ok: known })
    },
  }), `browser-control: POST ${ROUTE_RESULT}`)

  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  function rejected(req, res) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
}

function clampInt(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return max
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
