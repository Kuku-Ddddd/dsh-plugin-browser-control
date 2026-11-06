// Browser-control Client half: claims commands from the Host and performs them
// on the built-in browser carrier that the shipped sidebar-browser plugin mounts.
//
// Carriers found by the documented marker the shipped plugin sets:
//   [data-sidebar-browser-frame="webview"]  Desktop (Electron <webview>; full
//     guest API: loadURL/getURL/getTitle/executeJavaScript/capturePage)
//   [data-sidebar-browser-frame="iframe"]   Web (sandboxed <iframe>; same-origin
//     reads only, no screenshot)
window.__ModuleLoader__.load({
  id: 'dsh-plugin-browser-control',
  factory() {
    const NEXT = '/browser-control/next'
    const RESULT = '/browser-control/result'
    const POLL_ERROR_BACKOFF_MS = 4000

    /** All browser carriers in DOM order. */
    function allFrames() {
      return Array.prototype.slice.call(
        document.querySelectorAll('[data-sidebar-browser-frame]')
      )
    }

    /** The carrier we should act on: a requested index, else a visible tab, else the newest one. */
    function findFrame(index) {
      const all = allFrames()
      if (all.length === 0) return undefined
      if (typeof index === 'number') {
        return all[index] ?? all[all.length - 1]
      }
      const visible = all.filter((el) => el.isConnected && el.offsetParent !== null)
      const pool = visible.length > 0 ? visible : all
      return pool[pool.length - 1]
    }

    function describe(el) {
      return el === undefined ? 'none' : String(el.dataset.sidebarBrowserFrame)
    }

    function isWebview(el) {
      // The marker is authoritative: the shipped plugin names the carrier it
      // mounted. Method availability varies with guest attachment lifetime.
      return el !== undefined && el.dataset.sidebarBrowserFrame === 'webview'
    }

    const sleep = (ms, signal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      if (signal !== undefined) signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })

    /** Resolve once the carrier finished loading, or the deadline passed. */
    async function waitForSettle(el, signal, deadlineMs) {
      const deadline = Date.now() + deadlineMs
      if (isWebview(el)) {
        while (Date.now() < deadline) {
          if (signal !== undefined && signal.aborted) return
          let loading = true
          try { loading = el.isLoading() } catch { /* detached mid-navigation */ return }
          if (!loading) {
            // Give the guest a beat past the stop event so DOM reads and
            // executeJavaScript see a created document.
            await sleep(150, signal)
            return
          }
          await sleep(150, signal)
        }
        return
      }
      if (el.contentDocument !== null && el.contentDocument.readyState === 'complete') return
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer)
          el.removeEventListener('load', done)
          if (signal !== undefined) signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
        el.addEventListener('load', done)
        if (signal !== undefined) signal.addEventListener('abort', done, { once: true })
      })
    }

    function requireFrame(command) {
      const el = findFrame(command.tab)
      if (el === undefined) {
        throw new Error(
          'no built-in browser tab is open. Ask the user to open the right Sidebar '
          + '"Browser" tab (or call action "open" with a url).'
        )
      }
      return el
    }

    function frameInfo(el) {
      const info = { carrier: describe(el) }
      const read = (fn) => { try { return fn() } catch { return undefined } }
      info.url = read(() => (typeof el.getURL === 'function' ? el.getURL() : el.getAttribute?.('src') ?? el.src))
      info.title = read(() => el.getTitle())
      info.loading = read(() => el.isLoading())
      info.canGoBack = read(() => el.canGoBack())
      info.canGoForward = read(() => el.canGoForward())
      return info
    }

    /** The one error every selector-driven action shares. */
    const notFound = (selector) => new Error(
      `no element matched ${JSON.stringify(selector)}; run action "evaluate" to inspect the DOM and pick a real selector`
    )

    /** Run a function body inside the guest and return its JSON value. */
    async function guestEval(el, body) {
      if (!isWebview(el)) {
        throw new Error(
          'in-page scripting needs the Desktop carrier (Electron webview). '
          + `This tab uses the ${describe(el)} carrier, where cross-origin scripts are blocked by design.`
        )
      }
      const code = `(async () => { ${body} })()`
      const attempts = []
      // A guest whose frame is not up yet answers "ExecuteJavaScript has been
      // denied because document has not been created"; wait and retry.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await el.executeJavaScript(code, true)
        } catch (error) {
          const message = String(error instanceof Error ? error.message : error)
          attempts.push(message)
          if (!/document has not been created|not (?:been )?attached|frame|guest/i.test(message)) throw error
          await sleep(400 * (attempt + 1))
        }
      }
      throw new Error(`the page did not accept scripting (${attempts[attempts.length - 1]})`)
    }

    /** Bound one guest eval: a click that navigates can kill the script context. */
    async function guestEvalBounded(el, body, ms) {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('eval-timeout')), ms)
        guestEval(el, body).then(
          (value) => { clearTimeout(timer); resolve(value) },
          (error) => { clearTimeout(timer); reject(error) },
        )
      })
    }

    /** A click that navigated destroys the context before its value lands. */
    function looksLikeNavigation(error) {
      return /eval-timeout|document has not been created|context|navigation|frame was detached/i
        .test(String(error instanceof Error ? error.message : error))
    }

    /** Re-read the carrier after an action that may have moved the page. */
    async function pageAfterAction(el, signal, ms, command) {
      const target = findFrame(command?.tab) ?? el
      await waitForSettle(target, signal, ms ?? 8000)
      return frameInfo(target)
    }

    // One prelude for every selector-driven action: resolve the target, bring
    // it into view, and hand back its box. Each action then only adds the events
    // it actually dispatches, instead of repeating this four times.
    const prelude = (selector) => `
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (typeof el.focus === 'function') el.focus();
      const b = el.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, view: window, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, button: 0 };
      const label = String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120);
      const tag = el.tagName.toLowerCase();`

    const CLICK_BODY = (selector) => `${prelude(selector)}
      for (const [Ctor, type] of [[PointerEvent, 'pointerover'], [MouseEvent, 'mouseover']]) el.dispatchEvent(new Ctor(type, { ...at, pointerId: 1 }));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', at));
      el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', at));
      el.dispatchEvent(new MouseEvent('click', at));
      return { found: true, tag, text: label, href: el.getAttribute('href'), target: el.getAttribute('target'), disabled: el.disabled === true };`

    const FILL_BODY = (selector, value) => `${prelude(selector)}
      const type = String(el.type || '').toLowerCase();
      const text = ${JSON.stringify(String(value))};
      if (tag === 'select') {
        const hit = Array.from(el.options).find((o) => o.value === text || o.textContent.trim() === text);
        if (hit === undefined) return { found: true, tag, type: 'select', reason: 'no option matched the value' };
        el.value = hit.value;
      } else if (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'file', 'submit', 'button', 'image', 'range', 'color'].includes(type))) {
        // React/Vue track the value property, so a plain assignment never fires
        // their onChange. Call the native setter to keep their state in sync.
        const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter === undefined) el.value = text; else setter.call(el, text);
      } else {
        return { found: true, tag, type: type || null, reason: 'not a text field' };
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      const shown = String(el.value ?? '');
      return { found: true, tag, type: type || null, length: shown.length, preview: shown.slice(0, 80) };`

    const HOVER_BODY = (selector) => `${prelude(selector)}
      for (const [Ctor, type] of [[PointerEvent, 'pointerover'], [MouseEvent, 'mouseover']]) el.dispatchEvent(new Ctor(type, { ...at, pointerId: 1 }));
      for (const [Ctor, type] of [[PointerEvent, 'pointerenter'], [MouseEvent, 'mouseenter']]) el.dispatchEvent(new Ctor(type, { ...at, pointerId: 1, bubbles: false }));
      el.dispatchEvent(new PointerEvent('pointermove', { ...at, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousemove', at));
      return { found: true, tag, text: label };`;

    // press targets the explicit selector when given, else whatever has focus.
    const PRESS_BODY = (selector, key) => `
      const el = ${selector === undefined ? '(document.activeElement ?? document.body)' : `document.querySelector(${JSON.stringify(selector)})`};
      if (el === null || el === undefined) return { found: false, reason: ${selector === undefined ? "'no-focus'" : "'no-match'"} };
      const k = ${JSON.stringify(String(key))};
      if (typeof el.focus === 'function') el.focus();
      const base = { bubbles: true, cancelable: true, view: window, key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k };
      if (k.length === 1) base.keyCode = k.toUpperCase().charCodeAt(0);
      el.dispatchEvent(new KeyboardEvent('keydown', base));
      el.dispatchEvent(new KeyboardEvent('keypress', base));
      el.dispatchEvent(new KeyboardEvent('keyup', base));
      return { found: true, tag: el.tagName.toLowerCase(), wasFocused: el === document.activeElement };`;

    const handlers = {
      async open(command, signal) {
        const el = findFrame(command.tab)
        if (el !== undefined && isWebview(el)) {
          // Reuse the visible tab: faster and keeps one controlled surface.
          el.loadURL(command.url)
          await waitForSettle(el, signal, 20000)
          return { ...frameInfo(el), reusedTab: true }
        }
        if (el !== undefined) {
          el.setAttribute('src', command.url)
          await waitForSettle(el, signal, 20000)
          return { ...frameInfo(el), reusedTab: true }
        }
        sidebarRight.openTab('browser', { params: { url: command.url } })
        const deadline = Date.now() + 12000
        while (Date.now() < deadline) {
          const created = findFrame()
          if (created !== undefined) {
            await waitForSettle(created, signal, 20000)
            return { ...frameInfo(created), openedNewTab: true }
          }
          await sleep(200, signal)
        }
        return { openedNewTab: true, note: 'the tab was opened but its carrier was not observable yet; call status next' }
      },
      async navigate(command, signal) {
        const el = requireFrame(command)
        if (typeof el.loadURL === 'function') el.loadURL(command.url)
        else el.setAttribute('src', command.url)
        await waitForSettle(el, signal, 20000)
        return frameInfo(el)
      },
      async back(command, signal) {
        const el = requireFrame(command)
        if (typeof el.goBack !== 'function') {
          throw new Error(`the ${describe(el)} carrier exposes no goBack(); use navigate with the previous URL`)
        }
        if (!el.canGoBack()) return { ...frameInfo(el), note: 'no history entry behind this page' }
        el.goBack()
        await waitForSettle(el, signal, 15000)
        return frameInfo(el)
      },
      async forward(command, signal) {
        const el = requireFrame(command)
        if (typeof el.goForward !== 'function') {
          throw new Error(`the ${describe(el)} carrier exposes no goForward(); use navigate with the next URL`)
        }
        if (!el.canGoForward()) return { ...frameInfo(el), note: 'no history entry ahead of this page' }
        el.goForward()
        await waitForSettle(el, signal, 15000)
        return frameInfo(el)
      },
      async reload(command, signal) {
        const el = requireFrame(command)
        if (typeof el.reload === 'function') el.reload()
        else el.setAttribute('src', el.src)
        await waitForSettle(el, signal, 20000)
        return frameInfo(el)
      },
      async list() {
        const all = allFrames()
        return {
          total: all.length,
          tabs: all.map((el, i) => ({ ...frameInfo(el), index: i, visible: el.offsetParent !== null })),
        }
      },
      async status(command) {
        const el = findFrame(command.tab)
        if (el === undefined) return { carrier: 'none', tabs: 0, note: 'no built-in browser tab is open' }
        return { ...frameInfo(el), tab: command.tab ?? allFrames().indexOf(el), tabs: allFrames().length }
      },
      async read(command) {
        const el = requireFrame(command)
        const maxChars = command.maxChars ?? 20000
        if (isWebview(el)) {
          const value = await guestEval(el, `
            const d = document;
            const text = (d.body && d.body.innerText) || (d.documentElement && d.documentElement.textContent) || '';
            return { text, url: d.location.href, title: d.title, links:
              Array.prototype.slice.call(d.querySelectorAll('a[href]'), 0, 80).map((a) => ({ text: (a.innerText || '').trim().slice(0,80), href: a.href }))
            };`)
          const text = String(value?.text ?? '')
          return {
            url: value?.url, title: value?.title,
            text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated ${String(text.length - maxChars)} chars]` : text,
            truncated: text.length > maxChars,
            links: value?.links,
            carrier: 'webview',
          }
        }
        let doc
        try { doc = el.contentDocument } catch { doc = null }
        if (doc === null || doc.documentElement === undefined) {
          throw new Error(
            'the iframe carrier only exposes same-origin documents, so a cross-origin page cannot be read from here. '
            + 'Use Desktop (the app window) for full reads, or action "screenshot" where available.'
          )
        }
        const text = (doc.body && doc.body.innerText) || doc.documentElement.textContent || ''
        return {
          url: doc.location?.href ?? el.src, title: doc.title,
          text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated ${String(text.length - maxChars)} chars]` : text,
          truncated: text.length > maxChars, carrier: 'iframe',
        }
      },
      async evaluate(command) {
        const el = requireFrame(command)
        const value = await guestEval(el, command.script)
        return { result: value, carrier: 'webview' }
      },
      async click(command, signal) {
        const el = requireFrame(command)
        let value
        try {
          value = await guestEvalBounded(el, CLICK_BODY(command.selector), 6000)
        } catch (error) {
          // A link click can destroy this script context before its value
          // lands. That still means the events fired, so report the new page.
          if (!looksLikeNavigation(error)) throw error
          const page = await pageAfterAction(el, signal, undefined, command)
          return { carrier: 'webview', clicked: { selector: command.selector, note: 'the click navigated before its own result could return' }, page }
        }
        if (value?.found !== true) throw notFound(command.selector)
        return {
          carrier: 'webview',
          clicked: { tag: value.tag, text: value.text, href: value.href, disabled: value.disabled, target: value.target },
          page: await pageAfterAction(el, signal, undefined, command),
        }
      },
      async fill(command, signal) {
        const el = requireFrame(command)
        const value = await guestEval(el, FILL_BODY(command.selector, command.value))
        if (value?.found !== true) throw notFound(command.selector)
        if (value.reason !== undefined) throw new Error(`cannot fill this element: ${value.reason} (${value.tag})`)
        return { carrier: 'webview', filled: { tag: value.tag, type: value.type, length: value.length, preview: value.preview } }
      },
      async hover(command) {
        const el = requireFrame(command)
        const value = await guestEval(el, HOVER_BODY(command.selector))
        if (value?.found !== true) throw notFound(command.selector)
        return { carrier: 'webview', hovered: { tag: value.tag, text: value.text }, note: 'a hover menu opened by these events may need a screenshot or a second click while it is still open' }
      },
      async press(command, signal) {
        const el = requireFrame(command)
        let value
        try {
          value = await guestEvalBounded(el, PRESS_BODY(command.selector, command.key), 6000)
        } catch (error) {
          if (!looksLikeNavigation(error)) throw error
          const page = await pageAfterAction(el, signal, undefined, command)
          return { carrier: 'webview', pressed: { key: command.key, note: 'the key press navigated before its own result could return' }, page }
        }
        if (value?.found !== true) {
          throw value?.reason === 'no-focus'
            ? new Error('nothing had focus to receive the key; pass a selector or click the field first')
            : notFound(command.selector)
        }
        return {
          carrier: 'webview',
          pressed: { key: command.key, tag: value.tag, wasFocused: value.wasFocused },
          page: command.key === 'Enter'
            ? await pageAfterAction(el, signal, undefined, command)
            : frameInfo(findFrame(command.tab) ?? el),
        }
      },
      async screenshot(command, signal) {
        let el = requireFrame(command)
        if (typeof el.capturePage !== 'function') {
          throw new Error(
            `the ${describe(el)} carrier has no capturePage(); screenshots need the Desktop webview carrier.`
          )
        }
        const captureOnce = (target, ms, rect) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('capture-timeout')), ms)
          const pending = rect === undefined ? target.capturePage() : target.capturePage(rect)
          pending.then(
            (value) => { clearTimeout(timer); resolve(value) },
            (error) => { clearTimeout(timer); reject(error) },
          )
        })
        // Reveal only when the carrier is actually hidden: Desktop keeps
        // browser tabs mounted (keepMounted) behind other tabs and capture
        // of a hidden guest returns the window, not the page — but an
        // unnecessary reveal can remount the guest and hang capture, so
        // leave an on-screen tab alone.
        if (el.offsetParent === null) {
          try {
            if (typeof sidebarRight?.openTab === 'function') sidebarRight.openTab('browser')
          } catch { /* focus is best-effort; capture anyway */ }
          await sleep(500, signal)
          el = findFrame() ?? el
          if (!el.isConnected) throw new Error('the browser tab detached while being revealed; reopen it with action "open"')
        }
        let image
        try {
          image = await captureOnce(el, 10000)
        } catch {
          // Second chance: re-focus the tab and capture the element exposed
          // now, this time with an explicit viewport rect (the no-argument
          // form has been observed to never answer on a settled guest).
          try {
            if (typeof sidebarRight?.openTab === 'function') sidebarRight.openTab('browser')
          } catch { /* best-effort */ }
          await sleep(600, signal)
          const fresh = findFrame()
          if (fresh === undefined || !fresh.isConnected) {
            throw new Error('the browser tab vanished during the capture; reopen it with action "open" and retry')
          }
          if (typeof fresh.capturePage !== 'function') throw new Error('the re-found carrier has no capturePage()')
          const rect = {
            x: 0,
            y: 0,
            width: Math.max(1, fresh.clientWidth || 800),
            height: Math.max(1, fresh.clientHeight || 600),
          }
          image = await captureOnce(fresh, 8000, rect)
          el = fresh
        }
        const dataUrl = image.toDataURL()
        const comma = String(dataUrl).indexOf(',')
        const header = String(dataUrl).slice(0, comma)
        const mimeType = header.slice(header.indexOf(':') + 1, header.indexOf(';')) || 'image/png'
        return {
          contentParts: [{ mimeType, base64: String(dataUrl).slice(comma + 1) }],
          url: (() => { try { return el.getURL() } catch { return undefined } })(),
          carrier: 'webview',
        }
      },
    }

    async function run(command, signal) {
      const handler = handlers[command.action]
      if (handler === undefined) throw new Error(`unsupported action ${String(command.action)}`)
      return await handler(command, signal)
    }

    async function report(id, payload) {
      try {
        await fetch(RESULT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, ...payload }),
        })
      } catch { /* the Host timed the command out anyway */ }
    }

    let sidebarRight

    return {
      inject: ['sidebarRight'],
      apply(ctx) {
        return ctx.effect(() => {
        const controller = new AbortController()
        const signal = controller.signal
        sidebarRight = ctx.sidebarRight

        const loop = (async () => {
          while (!signal.aborted) {
            let command
            try {
              const response = await fetch(`${NEXT}?wait=1`, { credentials: 'same-origin', signal })
              if (!response.ok) throw new Error(`claim failed: HTTP ${String(response.status)}`)
              command = await response.json()
            } catch (error) {
              if (signal.aborted) return
              await sleep(POLL_ERROR_BACKOFF_MS, signal)
              continue
            }
            if (command === null || command === undefined) continue
            let settled
            try {
              settled = { ok: true, value: await run(command, signal) }
            } catch (error) {
              settled = { ok: false, error: String(error instanceof Error ? error.message : error) }
            }
            if (signal.aborted) return
            await report(command.id, settled)
          }
        })().catch((error) => {
          if (!signal.aborted) console.warn('[dsh-browser-control] command loop stopped:', error?.message ?? error)
        })

          return () => {
            controller.abort()
            sidebarRight = undefined
          }
        })
      },
    }
  },
})
