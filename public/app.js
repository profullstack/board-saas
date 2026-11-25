// Board as a Service front page. Talks only to /api (absolute when served from the c0mpute
// gateway, which is a different origin). Auth is an API key kept in localStorage.
(function () {
  'use strict';
  var HOME = 'https://board.saas.pit.world';
  var onHome = /(^|\.)board\.saas(\.pit\.world)?$/.test(location.hostname);
  var API = onHome ? '' : HOME;
  var KEY = 'board-saas:key';
  var EMAIL = 'board-saas:email';

  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  var $ = function (id) { return document.getElementById(id); };
  var form = $('meet-form'), brief = $('brief'), email = $('email'), code = $('code');
  var codeRow = $('code-row'), status = $('status'), submit = $('submit');
  var signedOut = $('signed-out'), signedIn = $('signed-in'), count = $('count');
  var voice = $('voice'), record = $('record'), recordRow = $('record-row'), voiceStatus = $('voice-status');
  voice.addEventListener('change', function () { recordRow.hidden = !voice.checked; });

  var EXAMPLE = 'Decision: should I raise prices on my $29/month SaaS, and by how much?\n' +
    'Options: keep $29; raise to $39 for new customers only; raise to $39 for everyone with 60 days notice; add a $79 tier and keep $29.\n' +
    'Constraints: 410 paying customers, 3.1% monthly churn, solo founder working about 30 hours a week, 7 months of runway, no sales team.';

  function say(text, bad) { status.textContent = text; status.className = 'status' + (bad ? ' bad' : ''); }

  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'content-type': 'application/json' };
    var key = load(KEY);
    if (key && opts.auth !== false) headers.authorization = 'Bearer ' + key;
    var res = await fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { var err = new Error(data.error || ('request failed (' + res.status + ')')); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  async function refreshAccount() {
    var key = load(KEY);
    if (!key) { signedOut.hidden = false; signedIn.hidden = true; return; }
    try {
      var a = await api('/api/v1/account');
      signedOut.hidden = true; signedIn.hidden = false;
      var c0 = a.c0mpute || {};
      var what = a.free_meeting_available ? 'your free meeting is ready'
        : a.credits > 0 ? a.credits + ' prepaid meeting(s) left'
        : c0.connected ? 'paying as you go from ' + (c0.name || 'your c0mpute account') + (typeof c0.balance_usd === 'number' ? ' ($' + c0.balance_usd.toFixed(2) + ' balance)' : '')
        : 'connect c0mpute to pay as you go';
      if (a.voice && a.voice.summary) voiceStatus.textContent = a.voice.summary + '.';
      signedIn.innerHTML = '';
      signedIn.appendChild(document.createTextNode('Signed in as ' + (a.email || 'admin') + ' · ' + what + ' · '));
      if (c0.available && !a.free_meeting_available && !(a.credits > 0)) {
        if (c0.connected) {
          var top = document.createElement('a');
          top.href = c0.top_up_url; top.target = '_blank'; top.rel = 'noopener'; top.textContent = 'top up';
          signedIn.appendChild(top);
          signedIn.appendChild(document.createTextNode(' · '));
        } else {
          var conn = document.createElement('button');
          conn.type = 'button'; conn.className = 'link'; conn.textContent = 'connect c0mpute';
          conn.onclick = connectC0mpute;
          signedIn.appendChild(conn);
          signedIn.appendChild(document.createTextNode(' · '));
        }
      }
      var out = document.createElement('button');
      out.type = 'button'; out.className = 'link'; out.textContent = 'sign out';
      out.onclick = function () { store(KEY, null); refreshAccount(); };
      signedIn.appendChild(out);
    } catch (e) {
      if (e.status === 401) { store(KEY, null); signedOut.hidden = false; signedIn.hidden = true; }
    }
  }

  async function connectC0mpute() {
    try {
      var r = await api('/api/v1/c0mpute/connect', { method: 'POST', body: {} });
      say('Taking you to c0mpute to connect your account (it is your CoinPay account)…');
      location.href = r.authorize_url;
    } catch (e) { say(e.message, true); }
  }

  async function startMeeting() {
    say('Convening the board…');
    var body = { brief: brief.value };
    if (voice.checked) { body.voice = true; body.record = record.checked; say('Convening the board for a live call…'); }
    var m;
    try {
      m = await api('/api/v1/meetings', { method: 'POST', body: body });
    } catch (e) {
      if (e.data && e.data.code === 'connect_c0mpute') {
        say('Your free meeting is used. Meetings are now pay as you go from your c0mpute balance: Claude Opus 5.5 at our Anthropic cost plus 20%. Taking you to c0mpute to connect…');
        setTimeout(connectC0mpute, 2500);
        return;
      }
      if (e.data && e.data.code === 'insufficient_balance' && e.data.top_up_url) {
        say(e.message + ' ', true);
        var a = document.createElement('a');
        a.href = e.data.top_up_url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Top up on c0mpute';
        status.appendChild(a);
        return;
      }
      if (e.data && e.data.code === 'voice_trial_ended' && e.data.checkout_url) {
        say(e.message + ' Taking you to CoinPay…', true);
        setTimeout(function () { location.href = e.data.checkout_url; }, 2500);
        return;
      }
      throw e;
    }
    if (m.status === 'awaiting_payment' && m.checkout_url) {
      say('Your free meeting is used. Taking you to CoinPay to pay $' + m.price_usd + '…');
      location.href = m.checkout_url;
      return;
    }
    location.href = HOME + '/m/' + m.id;
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (brief.value.trim().length < 20) { say('Write a brief first: the decision, the options and the constraints.', true); brief.focus(); return; }
    submit.disabled = true;
    try {
      if (load(KEY)) { await startMeeting(); return; }
      if (!email.value.trim()) { say('Enter your email so we can confirm your free meeting.', true); email.focus(); return; }
      if (codeRow.hidden) {
        var r = await api('/api/v1/auth/code', { method: 'POST', auth: false, body: { email: email.value } });
        store(EMAIL, email.value.trim());
        codeRow.hidden = false; code.focus();
        say(r.message + '. Enter it above, then press Start the meeting again.');
        submit.textContent = 'Confirm code and start';
        return;
      }
      var v = await api('/api/v1/auth/verify', { method: 'POST', auth: false, body: { email: email.value, code: code.value } });
      store(KEY, v.api_key);
      await startMeeting();
    } catch (e) {
      say(e.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  $('example').addEventListener('click', function () { brief.value = EXAMPLE; brief.dispatchEvent(new Event('input')); brief.focus(); });
  brief.addEventListener('input', function () { count.textContent = brief.value.length + ' / 6000'; });
  if (load(EMAIL)) email.value = load(EMAIL);
  if (/[?&]voice=paid/.test(location.search)) say('Thanks: your voice pass is active once CoinPay confirms the payment (usually under a minute).');
  var q = new URLSearchParams(location.search);
  if (q.get('c0mpute') === 'connected') say('c0mpute connected. Your meetings are now charged to your c0mpute balance as you go. Press Start the meeting when your brief is ready.');
  else if (q.get('c0mpute_error')) say('c0mpute did not connect: ' + q.get('c0mpute_error'), true);
  if (q.has('c0mpute') || q.has('c0mpute_error')) { q.delete('c0mpute'); q.delete('c0mpute_error'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '')); }
  refreshAccount();
})();
