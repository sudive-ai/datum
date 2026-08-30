/**
 * The workbench page — one static HTML document, no framework, no build step.
 *
 * The UI has exactly one rendering path: it renders what `/api/history`
 * (replay) and `/events` (live) both produce — the same session events folded
 * by the same rules, so live rendering and historical replay cannot diverge.
 */
export const workbenchPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Datum Workbench</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3;
         display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 12px; align-items: baseline; }
  header h1 { font-size: 15px; margin: 0; }
  header span { font-size: 12px; color: #8b949e; }
  #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 72%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; line-height: 1.45; }
  .user { align-self: flex-end; background: #1f6feb; color: white; }
  .assistant { align-self: flex-start; background: #161b22; border: 1px solid #30363d; }
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
  input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid #30363d;
          background: #0d1117; color: inherit; font: inherit; }
  button { padding: 10px 16px; border-radius: 8px; border: 1px solid #30363d;
           background: #21262d; color: inherit; cursor: pointer; font: inherit; }
  button:disabled { opacity: 0.5; cursor: default; }
  #busy { font-size: 12px; color: #d29922; align-self: flex-start; }
  details.activity { align-self: flex-start; max-width: 80%; border: 1px solid #21262d;
                     border-radius: 8px; background: #10151c; font-size: 12.5px; }
  details.activity.is-error { border-color: #f85149; }
  details.activity summary { cursor: pointer; padding: 6px 10px; color: #8b949e; user-select: none; list-style: none; }
  details.activity summary::before { content: '▸ '; }
  details.activity[open] summary::before { content: '▾ '; }
  details.activity pre { margin: 0; padding: 8px 12px; border-top: 1px solid #21262d;
                         white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto;
                         color: #c9d1d9; font-size: 12px; }
  details.file summary { color: #58a6ff; }
  details.file pre { background: #0d1117; }
  .approval-card { margin: 4px 16px; padding: 10px 12px; border: 1px solid #d29922;
                   border-radius: 8px; background: #2b2205; font-size: 13px; }
  .approval-card pre { font-size: 11px; color: #8b949e; margin: 6px 0; }
  .approval-card button { margin-right: 8px; }
  .ask-card { margin: 4px 16px; padding: 10px 12px; border: 1px solid #1f6feb;
              border-radius: 8px; background: #0d1b2e; font-size: 13px; }
  .ask-card input { margin: 6px 8px 0 0; padding: 6px 8px; }
</style>
</head>
<body>
<header><h1>Datum Workbench</h1><span>every fact has a time and a place</span>
  <span style="margin-left:auto"></span>
  <select id="sessions" style="padding:6px 8px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:inherit;font:inherit"></select>
  <button id="new-session" style="padding:6px 12px">+ 新会话</button>
</header>
<div id="chat"></div>
<form id="composer">
  <input id="text" placeholder="Say something to your agent…" autocomplete="off">
  <button id="send">Send</button>
  <button id="cancel" type="button">Cancel</button>
</form>
<script type="module">
  const chat = document.getElementById('chat')
  const text = document.getElementById('text')
  const send = document.getElementById('send')
  const cancel = document.getElementById('cancel')

  // Minimal safe markdown renderer: escape first, then transform. No deps.
  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
  function inline(text) {
    const codes = []
    let out = text.replace(/\`([^\`]+)\`/g, (m, code) => {
      return '\0C' + (codes.push('<code>' + code + '</code>') - 1) + '\0'
    })
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return out.replace(/\0C(\d+)\0/g, (m, i) => codes[Number(i)])
  }
  function renderMarkdown(src) {
    const blocks = []
    let prepared = src.replace(/\`\`\`([\w-]*)\n?([\s\S]*?)\`\`\`/g, (m, lang, code) => {
      const i = blocks.push('<pre class="code"' + (lang ? ' data-lang="' + lang + '"' : '') + '><code>' + escapeHtml(code) + '</code></pre>') - 1
      return '\0B' + i + '\0'
    })
    prepared = escapeHtml(prepared)
    const lines = prepared.split('\n')
    let html = ''
    let i = 0
    const inlineOf = line => inline(line)
    while (i < lines.length) {
      const line = lines[i]
      const m = line.match(/^\0B(\d+)\0$/) || (line.length > 0 && line.match(/^\0B(\d+)\0\s*$/))
      if (m) { html += blocks[Number(m[1])] ; i++; continue }
      if (/^\s*$/.test(line)) { i++; continue }
      const heading = line.match(/^(#{1,6}) (.+)$/)
      if (heading) {
        const level = Math.min(heading[1].length, 4)
        html += '<h' + level + '>' + inlineOf(heading[2]) + '</h' + level + '>'
        i++; continue
      }
      if (/^(---|\*\*\*|___)\s*$/.test(line)) { html += '<hr>'; i++; continue }
      if (/^&gt; /.test(line) || /^> /.test(line)) {
        const quote = []
        while (i < lines.length && (/^&gt; /.test(lines[i]) || /^> /.test(lines[i]))) {
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
      if (/^\d+\. /.test(line)) {
        const items = []
        while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push('<li>' + inlineOf(lines[i].replace(/^\d+\. /, '')) + '</li>'); i++ }
        html += '<ol>' + items.join('') + '</ol>'
        continue
      }
      if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[ :\-|]+\|$/.test(lines[i + 1])) {
        const header = line.split('|').slice(1, -1).map(c => c.trim())
        i += 2
        const rows = []
        while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
          rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()))
          i++
        }
        html += '<table><thead><tr>' + header.map(c => '<th>' + inlineOf(c) + '</th>').join('') + '</tr></thead><tbody>'
          + rows.map(row => '<tr>' + row.map(c => '<td>' + inlineOf(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
        continue
      }
      const para = []
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6} |[-*] |\d+\. |> |\||\0B)/.test(lines[i]) && !/^(---|\*\*\*|___)\s*$/.test(lines[i])) {
        para.push(lines[i])
        i++
      }
      if (para.length > 0) html += '<p>' + para.map(inlineOf).join('<br>') + '</p>'
      else i++
    }
    return html + blocks.map((b, idx) => html.includes('\0B' + idx + '\0') ? '' : '').join('')
      .replace(/\0B(\d+)\0/g, (m, idx2) => blocks[Number(idx2)] ?? '')
  }

  // Expanded details survive re-renders (the live stream refetches often).
  const openEntries = new Set()
  function render(state) {
    chat.innerHTML = ''
    let index = 0
    for (const entry of state.entries) {
      if (entry.kind === 'message') {
        const div = document.createElement('div')
        div.className = 'msg ' + entry.role
        if (entry.role === 'assistant') {
          div.classList.add('md')
          div.innerHTML = renderMarkdown(entry.text)
        } else {
          div.textContent = entry.text
        }
        chat.appendChild(div)
      } else {
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
        summary.textContent = (entry.file ? '' : '') + entry.text
        details.appendChild(summary)
        const body = document.createElement('pre')
        body.textContent = entry.file ? entry.file.content : (entry.detail ?? '')
        details.appendChild(body)
        chat.appendChild(details)
      }
      index++
    }
    if (state.busy) {
      const busy = document.createElement('div')
      busy.id = 'busy'
      busy.textContent = '… thinking'
      chat.appendChild(busy)
    }
    send.disabled = state.busy
    chat.scrollTop = chat.scrollHeight
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
  cancel.addEventListener('click', () => post('/api/cancel', {}))

  render(await (await fetch('/api/history')).json())

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
    fetch('/api/sessions/' + event.target.value + '/activate', { method: 'POST' })
  })
  document.getElementById('new-session').addEventListener('click', () => {
    fetch('/api/sessions', { method: 'POST' })
  })

  const stream = new EventSource('/events')
  stream.onmessage = () => {
    fetch('/api/history').then(response => response.json()).then(render)
  }
  // Switching or creating sessions pushes a 'session' frame: reload the view.
  stream.addEventListener('session', () => {
    renderSessions()
    fetch('/api/history').then(response => response.json()).then(render)
  })

  // Interactive asking: the agent pauses for your answer.
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
    const send = document.createElement('button')
    send.textContent = '回答'
    send.onclick = () => { const v = input.value.trim(); if (v) answerAsk(id, v, card) }
    card.appendChild(send)
    asks.appendChild(card)
  })
  source.addEventListener('ask-answered', event => {
    const { id } = JSON.parse(event.data)
    document.getElementById('ask-' + id)?.remove()
  })
  async function answerAsk(id, answer, card) {
    await fetch('/api/asks/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    })
    card.remove()
  }

  // Governance you can see: guarded tools open an approval card.
  const approvals = document.createElement('div')
  approvals.id = 'approvals'
  document.body.insertBefore(approvals, document.getElementById('composer'))
  const source = new EventSource('/events')
  source.addEventListener('approval', event => {
    const { id, tool, input } = JSON.parse(event.data)
    const card = document.createElement('div')
    card.className = 'approval-card'
    card.innerHTML = '<b>' + tool + '</b> 请求执行（需要你的批准）<pre>' +
      JSON.stringify(input, null, 2) + '</pre>'
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
    await fetch('/api/approvals/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    })
    card.remove()
  }
</script>
</body>
</html>
`
