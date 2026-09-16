/**
 * The dashboard, inlined rather than served from disk. On Vercel anything in a
 * static directory is served before the app sees it, which would put the page
 * outside the password gate.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Eduwalls AutoGTM</title>
<style>
  :root {
    --bg:#0B1C2C; --card:#132234; --card2:#1A2E44; --accent:#2ECC8F;
    --sec:#8BA3B5; --text:#EEF3F7; --muted:#4E6678; --err:#E05252; --warn:#F5A623;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,sans-serif;font-size:14px}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 24px;border-bottom:1px solid var(--card2);background:var(--card)}
  h1{font-size:16px;margin:0;letter-spacing:.3px;white-space:nowrap}
  h1 span{color:var(--accent)}
  .pill{padding:4px 10px;border-radius:999px;background:var(--card2);color:var(--sec);font-size:12px;white-space:nowrap}
  .pill.live{background:rgba(46,204,143,.15);color:var(--accent)}
  .pill.dry{background:rgba(245,166,35,.15);color:var(--warn)}
  .pill.bad{background:rgba(224,82,82,.15);color:var(--err)}
  button{background:var(--accent);color:#06121C;border:0;border-radius:6px;padding:8px 14px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit}
  button.ghost{background:var(--card2);color:var(--text)}
  button:disabled{opacity:.5;cursor:default}
  .tabs{display:flex;gap:4px;padding:12px 24px 0}
  .tab{background:none;color:var(--sec);border-bottom:2px solid transparent;border-radius:0;padding:8px 14px;font-weight:500}
  .tab.on{color:var(--accent);border-bottom-color:var(--accent)}
  main{display:grid;grid-template-columns:340px 1fr;gap:16px;padding:16px 24px;align-items:start}
  @media(max-width:900px){main{grid-template-columns:1fr}}
  .wide{display:block;padding:16px 24px;max-width:860px}
  .card{background:var(--card);border-radius:10px;padding:16px;margin-bottom:16px}
  .card h2{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--sec);margin:0 0 12px}
  input,textarea,select{width:100%;background:var(--card2);border:1px solid transparent;border-radius:6px;color:var(--text);padding:9px 10px;font-family:inherit;font-size:13px;margin-bottom:8px}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent)}
  label{display:block;font-size:11px;color:var(--sec);margin-bottom:4px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
  .row-check{display:flex;align-items:center;gap:8px;margin:6px 0 14px}
  .row-check input{width:auto;margin:0}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:11px;color:var(--sec);text-transform:uppercase;padding:6px 8px;font-weight:500}
  td{padding:8px;border-top:1px solid var(--card2);vertical-align:middle}
  tr.row:hover{background:var(--card2);cursor:pointer}
  .status{font-size:11px;padding:3px 8px;border-radius:4px;background:var(--card2);color:var(--sec)}
  .status.contacted,.status.followup_1,.status.sent{color:var(--accent)}
  .status.replied,.status.meeting_booked,.status.signed{background:rgba(46,204,143,.18);color:var(--accent)}
  .status.disqualified,.status.declined,.status.error,.status.failed{color:var(--err)}
  .score{font-variant-numeric:tabular-nums;color:var(--accent);font-weight:600}
  .stats{display:flex;gap:8px;flex-wrap:wrap}
  .stat{background:var(--card2);border-radius:8px;padding:10px 14px;min-width:86px}
  .stat b{display:block;font-size:20px}
  .stat span{font-size:11px;color:var(--sec)}
  .email{background:var(--card2);border-radius:8px;padding:14px;margin-top:10px}
  .email .subj{color:var(--accent);font-weight:600;margin-bottom:8px}
  .email pre{font-family:Georgia,serif;font-size:13px;line-height:1.85;white-space:pre-wrap;margin:0}
  .muted{color:var(--muted);font-size:12px}
  .err{color:var(--err);font-size:12px}
  .ok{color:var(--accent);font-size:12px}
  .warn{color:var(--warn);font-size:12px}
  .banner{border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:13px;line-height:1.6}
  .banner.blocked{background:rgba(224,82,82,.12);border-left:3px solid var(--err)}
  .banner.warn{background:rgba(245,166,35,.1);border-left:3px solid var(--warn)}
  .log{max-height:260px;overflow:auto;font-size:12px;color:var(--sec)}
  .log div{padding:4px 0;border-top:1px solid var(--card2)}
  .hint{font-size:11px;color:var(--muted);margin:-4px 0 12px}
  #detail{display:none}
  .test{margin-top:8px;font-size:12px;min-height:18px}
</style>
</head>
<body>
<header>
  <h1>Eduwalls <span>AutoGTM</span></h1>
  <span class="pill" id="transport">loading</span>
  <span class="pill" id="engine">engine</span>
  <span class="pill" id="quota">sent</span>
  <div style="flex:1"></div>
  <button class="ghost" id="btn-discover">Find schools</button>
  <button id="btn-tick">Run cycle now</button>
  <button class="ghost" id="btn-logout">Sign out</button>
</header>

<div class="tabs">
  <button class="tab on" data-tab="pipeline">Pipeline</button>
  <button class="tab" data-tab="settings">Settings</button>
</div>

<div id="view-pipeline">
  <main>
    <div>
      <div id="readiness"></div>
      <div class="card">
        <h2>Add a school</h2>
        <label>School name</label><input id="f-name" placeholder="Greensprings School" />
        <label>Area</label><input id="f-area" placeholder="Lekki" />
        <label>Contact email (optional)</label><input id="f-email" placeholder="info@school.com" />
        <label>Notes (optional)</label><textarea id="f-notes" rows="2" placeholder="Met the proprietor at the NAPPS meeting"></textarea>
        <button id="btn-add">Add to pipeline</button>
      </div>
      <div class="card"><h2>Pipeline</h2><div class="stats" id="stats"></div></div>
      <div class="card"><h2>Activity</h2><div class="log" id="log"></div></div>
    </div>
    <div>
      <div class="card" id="detail"></div>
      <div class="card">
        <h2>Schools</h2>
        <table>
          <thead><tr><th>School</th><th>Area</th><th>Score</th><th>Status</th><th>Next</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>
  </main>
</div>

<div id="view-settings" style="display:none">
  <div class="wide">
    <div class="card">
      <h2>Gemini</h2>
      <label>API key</label><input type="password" id="s-geminiApiKey" placeholder="Paste your key" />
      <div class="hint">The only key the agent needs to research, qualify and write. Leave blank to keep the current one.</div>
      <div class="grid2">
        <div><label>Research model</label><input id="s-researchModel" /></div>
        <div><label>Writer model</label><input id="s-writerModel" /></div>
      </div>
      <button class="ghost" data-test="gemini">Test connection</button><div class="test" id="t-gemini"></div>
    </div>

    <div class="card">
      <h2>Sender</h2>
      <div class="grid2">
        <div><label>From name</label><input id="s-fromName" /></div>
        <div><label>From address</label><input id="s-fromEmail" placeholder="hello@myeduwalls.com" /></div>
      </div>
      <label>Reply-to address</label><input id="s-replyTo" placeholder="Defaults to the from address" />
      <div class="hint">Replies land here. Point it at the mailbox you connect below, or the agent cannot see answers.</div>

      <label>Brevo API key</label><input type="password" id="s-brevoApiKey" placeholder="Preferred if set" />
      <div class="hint">Or use SMTP instead. Brevo wins when both are filled in.</div>
      <div class="grid2">
        <div><label>SMTP host</label><input id="s-smtpHost" placeholder="smtp.hostinger.com" /></div>
        <div><label>SMTP port</label><input id="s-smtpPort" /></div>
        <div><label>SMTP user</label><input id="s-smtpUser" /></div>
        <div><label>SMTP password</label><input type="password" id="s-smtpPass" /></div>
      </div>
      <div class="row-check"><input type="checkbox" id="s-liveSend" /><label style="margin:0">Live sending. Off means everything runs except delivery.</label></div>
      <button class="ghost" data-test="email">Test connection</button><div class="test" id="t-email"></div>
    </div>

    <div class="card">
      <h2>Mailbox for replies (IMAP)</h2>
      <div class="hint">Without this the agent cannot see replies and will keep following up with schools that already answered. For Gmail use an App Password, not your account password.</div>
      <div class="grid2">
        <div><label>IMAP host</label><input id="s-imapHost" placeholder="imap.gmail.com" /></div>
        <div><label>IMAP port</label><input id="s-imapPort" /></div>
        <div><label>IMAP user</label><input id="s-imapUser" /></div>
        <div><label>IMAP password</label><input type="password" id="s-imapPass" /></div>
      </div>
      <button class="ghost" data-test="imap">Test connection</button><div class="test" id="t-imap"></div>
    </div>

    <div class="card">
      <h2>HubSpot</h2>
      <label>Private app access token</label><input type="password" id="s-hubspotToken" />
      <div class="hint">Optional. Creates a Company, Deal and Note when Email 1 goes out.</div>
      <button class="ghost" data-test="hubspot">Test connection</button><div class="test" id="t-hubspot"></div>
    </div>

    <div class="card">
      <h2>Guard rails</h2>
      <div class="grid2">
        <div><label>Max sends per day</label><input id="s-maxSendsPerDay" /></div>
        <div><label>Max sends per cycle</label><input id="s-maxSendsPerTick" /></div>
        <div><label>Max research per cycle</label><input id="s-maxResearchPerTick" /></div>
        <div><label>Minimum score to contact</label><input id="s-minScoreToContact" /></div>
        <div><label>Follow up 1 (days)</label><input id="s-followUp1Days" /></div>
        <div><label>Follow up 2 (days)</label><input id="s-followUp2Days" /></div>
        <div><label>Send window start (WAT)</label><input id="s-sendStartHourWat" /></div>
        <div><label>Send window end (WAT)</label><input id="s-sendEndHourWat" /></div>
        <div><label>Top up funnel below</label><input id="s-discoverTargetBacklog" /></div>
        <div><label>Cycle seconds (server mode)</label><input id="s-engineTickSeconds" /></div>
      </div>
      <div class="row-check"><input type="checkbox" id="s-sendWindowEnabled" /><label style="margin:0">Only send during Lagos business hours, Monday to Friday</label></div>
      <div class="row-check"><input type="checkbox" id="s-autoDiscover" /><label style="margin:0">Find new schools automatically when the funnel runs thin</label></div>
      <div class="row-check"><input type="checkbox" id="s-engineEnabled" /><label style="margin:0">Engine enabled</label></div>
    </div>

    <button id="btn-save">Save settings</button>
    <button class="ghost" data-test="all">Test everything</button>
    <span id="save-msg" class="ok"></span>
    <p class="muted" id="enc-note"></p>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...(opts || {}) });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!res.ok) throw new Error((await res.text()).slice(0, 300));
  return res.json();
}

const SECRETS = ['geminiApiKey','brevoApiKey','smtpPass','imapPass','hubspotToken'];
const BOOLS = ['liveSend','autoDiscover','sendWindowEnabled','engineEnabled'];
const FIELDS = ['geminiApiKey','researchModel','writerModel','fromName','fromEmail','replyTo','brevoApiKey',
  'smtpHost','smtpPort','smtpUser','smtpPass','imapHost','imapPort','imapUser','imapPass','hubspotToken',
  'maxSendsPerDay','maxSendsPerTick','maxResearchPerTick','minScoreToContact','followUp1Days','followUp2Days',
  'sendStartHourWat','sendEndHourWat','discoverTargetBacklog','engineTickSeconds', ...BOOLS];

function fmtDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

async function refresh() {
  const [status, schools, events] = await Promise.all([
    api('/api/status'), api('/api/schools?limit=200'), api('/api/events?limit=60'),
  ]);

  const t = $('transport');
  t.textContent = status.sending.live ? 'live via ' + status.sending.transport : 'dry run, nothing is sent';
  t.className = 'pill ' + (status.sending.live ? 'live' : 'dry');
  const e = $('engine');
  e.textContent = status.engine.serverless
    ? (status.engine.enabled ? 'scheduled runs' : 'engine off')
    : (status.engine.running ? 'engine on' : 'engine off');
  e.className = 'pill' + (status.engine.enabled ? '' : ' bad');
  $('quota').textContent = status.sending.sentToday + '/' + status.sending.dailyCap + ' sent today';

  $('readiness').innerHTML =
    status.readiness.blockers.map((b) => '<div class="banner blocked">' + esc(b) + '</div>').join('') +
    status.readiness.warnings.map((w) => '<div class="banner warn">' + esc(w) + '</div>').join('');

  const order = ['discovered','researched','sequenced','contacted','followup_1','replied','meeting_booked','disqualified','error'];
  $('stats').innerHTML = order.filter((k) => status.pipeline[k])
    .map((k) => '<div class="stat"><b>' + status.pipeline[k] + '</b><span>' + k.replace('_',' ') + '</span></div>').join('')
    || '<span class="muted">Nothing in the pipeline yet.</span>';

  $('rows').innerHTML = schools.map((s) =>
    '<tr class="row" data-id="' + s.id + '"><td>' + esc(s.name) +
    (s.last_error ? '<div class="err">' + esc(s.last_error) + '</div>' : '') +
    '</td><td class="muted">' + esc(s.area || '') + '</td><td class="score">' + (s.score ?? '') +
    '</td><td><span class="status ' + s.status + '">' + s.status.replace('_',' ') + '</span></td>' +
    '<td class="muted">' + fmtDate(s.next_action_at) + '</td></tr>').join('');
  for (const tr of document.querySelectorAll('tr.row')) tr.onclick = () => openSchool(tr.dataset.id);

  $('log').innerHTML = events.map((ev) =>
    '<div>' + new Date(ev.created_at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) +
    ' <b>' + esc(ev.kind) + '</b> ' + esc(ev.school_name || '') + '</div>').join('');
}

async function openSchool(id) {
  const { school, emails } = await api('/api/schools/' + id);
  const brief = school.research_json ? JSON.parse(school.research_json) : null;
  const el = $('detail');
  el.style.display = 'block';
  el.innerHTML =
    '<h2>' + esc(school.name) + ' <span class="status ' + school.status + '">' + school.status.replace('_',' ') + '</span></h2>' +
    (brief ?
      '<p class="muted">' + esc(brief.inferred_profile || '') + '</p>' +
      '<p><b>Angle:</b> ' + esc(brief.recommended_angle || '') + '</p>' +
      '<p><b>Watch out:</b> ' + esc(brief.watch_out || '') + '</p>' +
      (brief.qualification ? '<p><b>Fit ' + brief.qualification.score + '/100:</b> ' + esc(brief.qualification.reasoning) + '</p>' : '')
      : '<p class="muted">Not researched yet.</p>') +
    '<label>Contact email</label><input id="d-email" value="' + esc(school.contact_email || '') + '" placeholder="Needed before anything sends" />' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="ghost" id="d-save">Save email</button>' +
    '<button class="ghost" id="d-prepare">Research and draft</button>' +
    '<button id="d-send">Send next email</button></div>' +
    emails.map((em) =>
      '<div class="email"><div class="subj">Email ' + em.step + ' &middot; ' + esc(em.subject) +
      ' <span class="status ' + em.status + '">' + em.status + '</span></div><pre>' + esc(em.body) + '</pre></div>').join('');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });

  $('d-save').onclick = () => run($('d-save'), async () => {
    await api('/api/schools/' + id, { method: 'PATCH', body: JSON.stringify({ contact_email: $('d-email').value.trim() }) });
    await openSchool(id);
  });
  $('d-prepare').onclick = () => run($('d-prepare'), async () => { await api('/api/schools/' + id + '/prepare', { method: 'POST', body: '{}' }); await openSchool(id); });
  $('d-send').onclick = () => run($('d-send'), async () => { await api('/api/schools/' + id + '/send-next', { method: 'POST', body: '{}' }); await openSchool(id); });
}

async function loadSettings() {
  const { settings, secretsEncrypted } = await api('/api/settings');
  for (const key of FIELDS) {
    const el = $('s-' + key);
    if (!el) continue;
    if (BOOLS.includes(key)) el.checked = Boolean(settings[key]);
    else if (SECRETS.includes(key)) { el.value = ''; el.placeholder = settings[key + '_configured'] ? 'Saved. Leave blank to keep.' : 'Not set'; }
    else el.value = settings[key] ?? '';
  }
  $('enc-note').textContent = secretsEncrypted
    ? 'Secrets are encrypted at rest with APP_SECRET.'
    : 'APP_SECRET is not set, so saved keys are stored as plain text in your database. Set it in Vercel and redeploy.';
}

async function saveSettingsForm() {
  const patch = {};
  for (const key of FIELDS) {
    const el = $('s-' + key);
    if (!el) continue;
    if (BOOLS.includes(key)) patch[key] = el.checked;
    else if (SECRETS.includes(key)) { if (el.value.trim()) patch[key] = el.value.trim(); }
    else patch[key] = el.value.trim();
  }
  await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  $('save-msg').textContent = 'Saved.';
  setTimeout(() => { $('save-msg').textContent = ''; }, 3000);
  await loadSettings();
  await refresh();
}

async function run(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Working...';
  try { await fn(); await refresh(); }
  catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = label; }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === tab);
    $('view-pipeline').style.display = tab.dataset.tab === 'pipeline' ? 'block' : 'none';
    $('view-settings').style.display = tab.dataset.tab === 'settings' ? 'block' : 'none';
    if (tab.dataset.tab === 'settings') loadSettings();
  };
}

for (const btn of document.querySelectorAll('[data-test]')) {
  btn.onclick = () => run(btn, async () => {
    const target = btn.dataset.test;
    const results = await api('/api/settings/test', { method: 'POST', body: JSON.stringify({ target }) });
    for (const [key, r] of Object.entries(results)) {
      const el = $('t-' + key);
      if (el) { el.className = 'test ' + (r.ok ? 'ok' : 'err'); el.textContent = (r.ok ? 'OK. ' : 'Failed. ') + r.detail; }
    }
  });
}

$('btn-save').onclick = () => run($('btn-save'), saveSettingsForm);
$('btn-add').onclick = () => run($('btn-add'), async () => {
  const name = $('f-name').value.trim();
  if (!name) return;
  await api('/api/schools', { method: 'POST', body: JSON.stringify({
    name, area: $('f-area').value.trim() || null,
    contact_email: $('f-email').value.trim() || null,
    notes: $('f-notes').value.trim() || null }) });
  for (const f of ['f-name','f-area','f-email','f-notes']) $(f).value = '';
});
$('btn-tick').onclick = () => run($('btn-tick'), () => api('/api/engine/tick', { method: 'POST', body: '{}' }));
$('btn-discover').onclick = () => run($('btn-discover'), () => api('/api/discover', { method: 'POST', body: JSON.stringify({ limit: 10 }) }));
$('btn-logout').onclick = async () => { await api('/api/logout', { method: 'POST', body: '{}' }); location.href = '/login'; };

refresh();
setInterval(refresh, 20000);
</script>
</body>
</html>`;
