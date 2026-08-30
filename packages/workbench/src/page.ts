/**
 * The workbench page — one static HTML document, no framework, no build step.
 *
 * The UI has exactly one rendering path: it renders what `/api/history`
 * (replay) and `/events` (live) both produce — the same session events folded
 * by the same rules, so live rendering and historical replay cannot diverge.
 *
 * NOTE: this file is one big template literal. Inside the embedded script,
 * every backtick, `${`, and regex backslash must be escaped for the .ts
 * layer (`\``, `\${`, `\\[`) — the test suite syntax-checks the emitted
 * script to keep this honest.
 */
export const workbenchPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Datum Workbench</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3;
         display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 15px; margin: 0; }
  header span { font-size: 12px; color: #8b949e; }
  header .spacer { margin-left: auto; }
  #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 72%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; line-height: 1.45; }
  .msg.user { align-self: flex-end; background: #1f6feb; color: white; }
  .msg.assistant { align-self: flex-start; background: #161b22; border: 1px solid #30363d; }
  .md p { margin: 0.35em 0; }
  .md p:first-child { margin-top: 0; }
  .md p:last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4 { margin: 0.6em 0 0.3em; line-height: 1.3; }
  .md h1 { font-size: 1.25em; } .md h2 { font-size: 1.15em; } .md h3 { font-size: 1.05em; }
  .md code { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
  .md pre.code { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px;
                 overflow-x: auto; margin: 0.5em 0; }
  .md pre.code code { border: none; background: none; padding: 0; }
  .md pre.code[data-lang]::before { content: attr(data-lang); display: block; font-size: 10px;
                                    color: #8b949e; margin-bottom: 4px; text-transform: uppercase; }
  .md ul, .md ol { margin: 0.35em 0; padding-left: 1.4em; }
  .md li { margin: 0.15em 0; }
  .md blockquote { margin: 0.4em 0; padding: 2px 12px; border-left: 3px solid #30363d; color: #8b949e; }
  .md table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.92em; }
  .md th, .md td { border: 1px solid #30363d; padding: 4px 10px; text-align: left; }
  .md th { background: #0d1117; }
  .md a { color: #58a6ff; }
  .md hr { border: none; border-top: 1px solid #30363d; margin: 0.6em 0; }
  form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #21262d; }
  input { padding: 10px 12px; border-radius: 8px; border: 1px solid #30363d;
          background: #0d1117; color: inherit; font: inherit; }
  form input { flex: 1; }
  button { padding: 10px 16px; border-radius: 8px; border: 1px solid #30363d;
           background: #21262d; color: inherit; cursor: pointer; font: inherit; }
  header button { padding: 6px 12px; }
  button:disabled { opacity: 0.5; cursor: default; }
  #busy { font-size: 12px; color: #d29922; align-self: flex-start; }
  details.activity { align-self: flex-start; max-width: 80%; border: 1px solid #21262d;
                     border-radius: 8px; background: #10151c; font-size: 12.5px; }
  details.activity.is-error { border-color: #f85149; }
  details.activity summary { cursor: pointer; padding: 6px 10px; color: #8b949e; user-select: none; list-style: none; }
  details.activity summary::before { content: '\\25B8 '; }
  details.activity[open] summary::before { content: '\\25BE '; }
  details.activity pre { margin: 0; padding: 8px 12px; border-top: 1px solid #21262d;
                         white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto;
                         color: #c9d1d9; font-size: 12px; }
  details.file summary { color: #58a6ff; }
  details.file pre { background: #0d1117; }
  .approval-card, .ask-card { margin: 4px 16px; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
  .approval-card { border: 1px solid #d29922; background: #2b2205; }
  .approval-card pre { font-size: 11px; color: #8b949e; margin: 6px 0; }
  .approval-card button, .ask-card button { margin-right: 8px; padding: 6px 12px; }
  .ask-card { border: 1px solid #1f6feb; background: #0d1b2e; }
  .ask-card input { margin: 6px 8px 0 0; padding: 6px 8px; }
</style>
</head>
<body>
<header><h1>Datum Workbench</h1><span>every fact has a time and a place</span>
  <span class="spacer"></span>
  <select id="sessions" style="padding:6px 8px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:inherit;font:inherit"></select>
  <button id="new-session">+ 新会话</button>
</header>
<div id="chat"></div>
<form id="composer">
  <input id="text" placeholder="对你的智能体说点什么…" autocomplete="off">
  <button id="send">发送</button>
  <button id="cancel" type="button">取消</button>
</form>
<script type="module">
  const chat = document.getElementById('chat')
  const text = document.getElementById('text')
  const send = document.getElementById('send')

  // --- minimal safe markdown: escape first, then transform ------------------
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
  function inline(text) {
    const codes = []
    let out = text.replace(/\\\`([^\\\`]+)\\\`/g, (m, code) => {
      return '\\0C' + (codes.push('<code>' + code + '</code>') - 1) + '\\0'
    })
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    out = out.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>')
    out = out.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return out.replace(/\\0C(\\d+)\\0/g, (m, i) => codes[Number(i)])
  }
  function renderMarkdown(src) {
    const blocks = []
    let prepared = src.replace(/\\\`\\\`\\\`([\\w-]*)\\n?([\\s\\S]*?)\\\`\\\`\\\`/g, (m, lang, code) => {
      const i = blocks.push('<pre class="code"' + (lang ? ' data-lang="' + lang + '"' : '') + '><code>' + escapeHtml(code) + '</code></pre>') - 1
      return '\\0B' + i + '\\0'
    })
    prepared = escapeHtml(prepared)
    const lines = prepared.split('\\n')
    let html = ''
    let i = 0
    const inlineOf = line => inline(line)
    while (i < lines.length) {
      const line = lines[i]
      const blockRef = line.match(/^\\0B(\\d+)\\0\\s*$/)
      if (blockRef) { html += blocks[Number(blockRef[1])] ?? ''; i++; continue }
      if (/^\\s*$/.test(line)) { i++; continue }
      const heading = line.match(/^(#{1,6}) (.+)$/)
      if (heading) {
        const level = Math.min(heading[1].length, 4)
        html += '<h' + level + '>' + inlineOf(heading[2]) + '</h' + level + '>'
        i++; continue
      }
      if (/^(---|\\*\\*\\*|___)\\s*$/.test(line)) { html += '<hr>'; i++; continue }
      if (/^(&gt;|>) /.test(line)) {
        const quote = []
        while (i < lines.length && /^(&gt;|>) /.test(lines[i])) {
          quote.push(lines[i].replace(/^(&gt;|>) /, ''))
          i++
        }
        html += '<blockquote>' + quote.map(inlineOf).join('<br>') + '</blockquote>'
        continue
      }
      if (/^[-*] /.test(line)) {
        const items = []
        while (i < lines.length && /^[-*] /.test(lines[i])) { items.push('<li>' + inlineOf(lines[i].slice(2)) + '</li>'); i++ }
        html += '<ul>' + items.join('') + '</ul>'
        continue
      }
      if (/^\\d+\\. /.test(line)) {
        const items = []
        while (i < lines.length && /^\\d+\\. /.test(lines[i])) { items.push('<li>' + inlineOf(lines[i].replace(/^\\d+\\. /, '')) + '</li>'); i++ }
        html += '<ol>' + items.join('') + '</ol>'
        continue
      }
      if (/^\\|.*\\|$/.test(line) && i + 1 < lines.length && /^\\|[ :\\-|]+\\|$/.test(lines[i + 1])) {
        const header = line.split('|').slice(1, -1).map(cell => cell.trim())
        i += 2
        const rows = []
        while (i < lines.length && /^\\|.*\\|$/.test(lines[i])) {
          rows.push(lines[i].split('|').slice(1, -1).map(cell => cell.trim()))
          i++
        }
        html += '<table><thead><tr>' + header.map(cell => '<th>' + inlineOf(cell) + '</th>').join('') + '</tr></thead><tbody>'
          + rows.map(row => '<tr>' + row.map(cell => '<td>' + inlineOf(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
        continue
      }
      const para = []
      while (i < lines.length && !/^\\s*$/.test(lines[i]) && !/^(#{1,6} |[-*] |\\d+\\. |(&gt;|>) |\\||\\0B)/.test(lines[i]) && !/^(---|\\*\\*\\*|___)\\s*$/.test(lines[i])) {
        para.push(lines[i])
        i++
      }
      if (para.length > 0) html += '<p>' + para.map(inlineOf).join('<br>') + '</p>'
      else i++
    }
    return html.replace(/\\0B(\\d+)\\0/g, (m, idx) => blocks[Number(idx)] ?? '')
  }

  // --- render: incremental; expanded state survives re-renders --------------
  let busy = null // null = nothing rendered yet — the first render never skips
  const openEntries = new Set()
  const entryNodes = []
  const entryKeys = []
  const mdCache = new Map()
  const cachedMarkdown = text => {
    if (!mdCache.has(text)) mdCache.set(text, renderMarkdown(text))
    return mdCache.get(text)
  }
  function buildEntry(entry, index) {
    if (entry.kind === 'message') {
      const div = document.createElement('div')
      div.className = 'msg ' + entry.role
      if (entry.role === 'assistant') {
        div.classList.add('md')
        div.innerHTML = cachedMarkdown(entry.text)
      } else {
        div.textContent = entry.text
      }
      return div
    }
    const id = 'act-' + index
    const details = document.createElement('details')
    details.className = 'activity' + (entry.isError ? ' is-error' : '') + (entry.file ? ' file' : '')
    details.id = id
    if (openEntries.has(id)) details.open = true
    details.addEventListener('toggle', () => {
      if (details.open) openEntries.add(id)
      else openEntries.delete(id)
    })
    const summary = document.createElement('summary')
    summary.textContent = entry.text
    details.appendChild(summary)
    const body = document.createElement('pre')
    body.textContent = entry.file ? entry.file.content : (entry.detail ?? '')
    details.appendChild(body)
    return details
  }
  // Entries live in their own container so the busy indicator is a single
  // persistent element — the incremental path never removes it, and it must
  // never accumulate.
  const entriesEl = document.createElement('div')
  chat.appendChild(entriesEl)
  const busyEl = document.createElement('div')
  busyEl.id = 'busy'
  busyEl.textContent = '… thinking'
  busyEl.style.display = 'none'
  chat.appendChild(busyEl)
  function render(state) {
    // Autoscroll only follows the output when the reader is already at the
    // bottom — scrolling up to read history must never be yanked back.
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80
    // Entry-level diff: untouched leading entries keep their DOM nodes, so
    // clicks and expansions are never destroyed under the cursor.
    const keys = state.entries.map(entry => JSON.stringify(entry))
    let divergence = 0
    const min = Math.min(keys.length, entryKeys.length)
    while (divergence < min && keys[divergence] === entryKeys[divergence]) divergence++
    if (divergence === keys.length && keys.length === entryKeys.length && busy === state.busy) return
    while (entryNodes.length > divergence) {
      entriesEl.removeChild(entryNodes.pop())
      entryKeys.pop()
    }
    for (let index = divergence; index < state.entries.length; index++) {
      const node = buildEntry(state.entries[index], index)
      entryNodes.push(node)
      entryKeys.push(keys[index])
      entriesEl.appendChild(node)
    }
    busyEl.style.display = state.busy ? '' : 'none'
    busy = state.busy
    send.disabled = state.busy
    if (nearBottom) chat.scrollTop = chat.scrollHeight
  }

  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) console.error(await response.text())
  }

  document.getElementById('composer').addEventListener('submit', event => {
    event.preventDefault()
    const value = text.value.trim()
    if (!value) return
    text.value = ''
    post('/api/messages', { text: value })
  })
  document.getElementById('cancel').addEventListener('click', () => post('/api/cancel', {}))

  // --- sessions ---------------------------------------------------------------
  async function renderSessions() {
    const data = await (await fetch('/api/sessions')).json()
    const select = document.getElementById('sessions')
    select.innerHTML = ''
    for (const item of data.sessions) {
      const option = document.createElement('option')
      option.value = item.sessionId
      option.textContent = item.sessionId.slice(0, 14) + ' · ' + new Date(item.lastTime).toLocaleString()
      if (item.sessionId === data.active) option.selected = true
      select.appendChild(option)
    }
  }
  renderSessions()
  document.getElementById('sessions').addEventListener('change', event => {
    post('/api/sessions/' + event.target.value + '/activate', {})
  })
  document.getElementById('new-session').addEventListener('click', () => post('/api/sessions', {}))

  // --- one live stream drives everything --------------------------------------
  //
  // Streaming turns emit many events per second: the stream only marks the
  // view dirty, and a throttled loop refetches at most ~4x/s, skipping
  // identical states. Fetch-per-chunk starved the connection pool (SSE
  // dropped mid-turn) and rebuilt the DOM so fast that clicks never landed.
  const source = new EventSource('/events')
  let historyDirty = false
  let sessionsDirty = false
  let lastRendered = ''
  source.onmessage = () => { historyDirty = true }
  // A switch/create frame is distinct from the per-event broadcast frames.
  source.addEventListener('session-switched', () => {
    sessionsDirty = true
    historyDirty = true
  })
  setInterval(() => {
    if (sessionsDirty) {
      sessionsDirty = false
      renderSessions()
    }
    if (historyDirty) {
      historyDirty = false
      fetch('/api/history').then(response => response.json()).then(state => {
        const serialized = JSON.stringify(state)
        if (serialized === lastRendered) return
        lastRendered = serialized
        render(state)
      }).catch(() => undefined)
    }
  }, 250)

  // --- interactive asking -------------------------------------------------------
  const asks = document.createElement('div')
  asks.id = 'asks'
  document.body.insertBefore(asks, document.getElementById('composer'))
  source.addEventListener('ask', event => {
    const { id, question, choices } = JSON.parse(event.data)
    const card = document.createElement('div')
    card.className = 'ask-card'
    const label = document.createElement('div')
    label.textContent = question
    card.appendChild(label)
    for (const choice of choices) {
      const button = document.createElement('button')
      button.textContent = choice
      button.onclick = () => answerAsk(id, choice, card)
      card.appendChild(button)
    }
    const input = document.createElement('input')
    input.placeholder = '或输入你的回答…'
    card.appendChild(input)
    const answerButton = document.createElement('button')
    answerButton.textContent = '回答'
    answerButton.onclick = () => { const v = input.value.trim(); if (v) answerAsk(id, v, card) }
    card.appendChild(answerButton)
    asks.appendChild(card)
  })
  source.addEventListener('ask-answered', event => {
    const { id } = JSON.parse(event.data)
    document.getElementById('ask-' + id)?.remove()
  })
  async function answerAsk(id, answer, card) {
    await post('/api/asks/' + id, { answer })
    card.remove()
  }

  // --- governance you can see ---------------------------------------------------
  const approvals = document.createElement('div')
  approvals.id = 'approvals'
  document.body.insertBefore(approvals, document.getElementById('composer'))
  source.addEventListener('approval', event => {
    const { id, tool, input } = JSON.parse(event.data)
    const card = document.createElement('div')
    card.className = 'approval-card'
    const label = document.createElement('div')
    label.innerHTML = '<b>' + escapeHtml(tool) + '</b> 请求执行（需要你的批准）'
    card.appendChild(label)
    const payload = document.createElement('pre')
    payload.textContent = JSON.stringify(input, null, 2)
    card.appendChild(payload)
    const grant = document.createElement('button')
    grant.textContent = '批准'
    grant.onclick = () => decide(id, 'granted', card)
    const deny = document.createElement('button')
    deny.textContent = '拒绝'
    deny.onclick = () => decide(id, 'denied', card)
    card.appendChild(grant)
    card.appendChild(deny)
    approvals.appendChild(card)
  })
  source.addEventListener('approval-decided', event => {
    const { id } = JSON.parse(event.data)
    document.getElementById('appr-' + id)?.remove()
  })
  async function decide(id, decision, card) {
    await post('/api/approvals/' + id, { decision })
    card.remove()
  }

  render(await (await fetch('/api/history')).json())
</script>
</body>
</html>
`
