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
  form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #21262d; }
  input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid #30363d;
          background: #0d1117; color: inherit; font: inherit; }
  button { padding: 10px 16px; border-radius: 8px; border: 1px solid #30363d;
           background: #21262d; color: inherit; cursor: pointer; font: inherit; }
  button:disabled { opacity: 0.5; cursor: default; }
  #busy { font-size: 12px; color: #d29922; align-self: flex-start; }
  .approval-card { margin: 4px 16px; padding: 10px 12px; border: 1px solid #d29922;
                   border-radius: 8px; background: #2b2205; font-size: 13px; }
  .approval-card pre { font-size: 11px; color: #8b949e; margin: 6px 0; }
  .approval-card button { margin-right: 8px; }
</style>
</head>
<body>
<header><h1>Datum Workbench</h1><span>every fact has a time and a place</span></header>
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

  function render(state) {
    chat.innerHTML = ''
    for (const message of state.messages) {
      const div = document.createElement('div')
      div.className = 'msg ' + message.role
      div.textContent = message.text
      chat.appendChild(div)
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
  new EventSource('/events').onmessage = () => {
    fetch('/api/history').then(response => response.json()).then(render)
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
