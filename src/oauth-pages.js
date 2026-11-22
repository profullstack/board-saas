// The two pages a person sees during OAuth: the consent page (/oauth/authorize) and the
// device page (/oauth/device). Both sign in inline with the emailed 6-digit code, so a
// connector popup is never a dead end, and both act with fetch + location.assign: a form
// POST that 302s to claude.ai is blocked by CSP form-action in Chrome.
import { randomBytes } from 'node:crypto';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1d1c1a;--mut:#6b6862;--card:#fff;--line:#dedbd4;--acc:#2f5d50;--bad:#a33}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe8;--mut:#a19e97;--card:#1d1d1b;--line:#33322f;--acc:#7fb8a4;--bad:#e88}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:440px;margin:8vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:0 0 12px}.mut{color:var(--mut);font-size:.9rem}ul{margin:0 0 16px;padding-left:20px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;margin:0 0 10px}
.row{display:flex;gap:10px}button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;flex:1}
button.go{background:var(--acc);border-color:var(--acc);color:var(--card)}button:disabled{opacity:.6}.status{min-height:1.5em;font-size:.9rem}.bad{color:var(--bad)}
code{font-size:1.05rem;letter-spacing:.08em}a{color:var(--acc)}`;

export function pageHeaders(nonce) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  };
}

export const newNonce = () => randomBytes(16).toString('base64');

function shell(title, body, nonce, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main><div class="card">${body}</div>
<p class="mut" style="margin-top:12px;text-align:center"><a href="/">Board as a Service</a></p></main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

// Shared sign-in widget: email -> code -> POST /oauth/session, then reload.
const SIGNIN_HTML = `<div id="signin"><p>Sign in with your email. We send a 6-digit code; no password.</p>
<input id="email" type="email" autocomplete="email" placeholder="you@example.com" required>
<input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" hidden>
<div class="row"><button id="send" class="go" type="button">Email me a code</button></div>
<p id="status" class="status" role="status"></p></div>`;

const SIGNIN_JS = `
var $=function(i){return document.getElementById(i)};
function say(t,b){var s=$('status');if(s){s.textContent=t;s.className='status'+(b?' bad':'')}}
async function post(p,b){var r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(b)});var d={};try{d=await r.json()}catch(e){}if(!r.ok)throw new Error(d.error_description||d.error||('request failed ('+r.status+')'));return d}
if($('send')){$('send').onclick=async function(){var btn=this;btn.disabled=true;try{
 if($('code').hidden){var r=await post('/api/v1/auth/code',{email:$('email').value});$('code').hidden=false;$('code').focus();btn.textContent='Sign in';say(r.message)}
 else{await post('/oauth/session',{email:$('email').value,code:$('code').value});location.reload()}
}catch(e){say(e.message,true)}finally{btn.disabled=false}}}
`;

export function errorPage(message, nonce) {
  return shell('Cannot connect', `<h1>This connection request is not valid</h1><p class="bad">${esc(message)}</p><p class="mut">Go back to the app you came from and start again.</p>`, nonce);
}

/** The consent page. `session` = { account, csrf } or null. */
export function consentPage({ client, redirectUri, session, query, nonce }) {
  const host = new URL(redirectUri).host || redirectUri;
  const who = esc(client.name);
  const head = `<h1>Connect ${who} to Board as a Service</h1>
<p><strong>${who}</strong> wants to act for your account. It will be able to:</p>
<ul><li>convene the board on a decision, including any company data it gives (financials, metrics)</li><li>read, list and answer the chair on your meetings</li><li>spend your free meeting or paid credits, never buy new ones without you</li></ul>
<p class="mut">After you allow it you go back to <strong>${esc(host)}</strong>. ${client.dynamic ? 'This app registered itself, so its name is its own claim; allow it only if you started this connection.' : ''}</p>`;
  if (!session) return shell('Connect to Board as a Service', head + SIGNIN_HTML, nonce, SIGNIN_JS);
  const body = `${head}<p class="mut">Signed in as ${esc(session.account.email)}. <a href="#" id="out">Not you?</a></p>
<div class="row"><button id="deny" type="button">Deny</button><button id="allow" class="go" type="button">Allow</button></div><p id="status" class="status" role="status"></p>`;
  const js = `${SIGNIN_JS}
var Q=${JSON.stringify(query).replace(/</g, '\\u003c')},C=${JSON.stringify(session.csrf)};
async function decide(a){$('allow').disabled=$('deny').disabled=true;try{var r=await post('/oauth/authorize',{query:Q,action:a,csrf:C});say(a==='approve'?'Connected. Taking you back…':'Denied. Taking you back…');location.assign(r.redirect)}catch(e){say(e.message,true);$('allow').disabled=$('deny').disabled=false}}
$('allow').onclick=function(){decide('approve')};$('deny').onclick=function(){decide('deny')};
$('out').onclick=async function(e){e.preventDefault();await post('/oauth/logout',{});location.reload()};`;
  return shell('Connect to Board as a Service', body, nonce, js);
}

/** The device page: type the code the terminal shows, then allow or deny. */
export function devicePage({ session, nonce }) {
  const head = '<h1>Connect a device to Board as a Service</h1>';
  if (!session) return shell('Connect a device', `${head}${SIGNIN_HTML}`, nonce, SIGNIN_JS);
  const body = `${head}<p class="mut">Signed in as ${esc(session.account.email)}. <a href="#" id="out">Not you?</a></p>
<div id="step1"><p>Type the code your terminal shows.</p><input id="uc" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX" maxlength="9"><div class="row"><button id="look" class="go" type="button">Continue</button></div></div>
<div id="step2" hidden><p><strong id="app"></strong> wants to act for your account: run, read, list and answer the chair on your meetings, using your free meeting or paid credits.</p><p class="mut">Allow it only if you started this in your own terminal just now.</p>
<div class="row"><button id="deny" type="button">Deny</button><button id="allow" class="go" type="button">Allow</button></div></div>
<p id="status" class="status" role="status"></p>`;
  const js = `${SIGNIN_JS}
var C=${JSON.stringify(session.csrf)};
$('look').onclick=async function(){try{var r=await post('/oauth/device',{user_code:$('uc').value,action:'lookup',csrf:C});$('app').textContent=r.client;$('step1').hidden=true;$('step2').hidden=false;say('')}catch(e){say(e.message,true)}};
async function decide(a){$('allow').disabled=$('deny').disabled=true;try{await post('/oauth/device',{user_code:$('uc').value,action:a,csrf:C});$('step2').hidden=true;say(a==='approve'?'Done. Go back to your terminal; it is signed in.':'Denied. You can close this page.')}catch(e){say(e.message,true);$('allow').disabled=$('deny').disabled=false}}
$('allow').onclick=function(){decide('approve')};$('deny').onclick=function(){decide('deny')};
$('out').onclick=async function(e){e.preventDefault();await post('/oauth/logout',{});location.reload()};`;
  return shell('Connect a device', body, nonce, js);
}
