// Server-rendered pages: the meeting page (status, live call, then the report), the owner's
// report with its private extras (recording, transcript, share links), share-link (invite)
// pages, public meeting pages and the public index.
//
// Private meetings: /m/<id> is a shell that signs in with the API key the front page keeps in
// localStorage, reads the meeting over the API and, once it is done, swaps in the report from
// /api/v1/meetings/<id>/page.html. Nothing private is in the shell itself.
import { allFooters } from './footers.js';
import { renderReport } from './render-report.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (t) => {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const NAV = 'display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;max-width:920px;margin:0 auto;padding:12px 16px;border-bottom:1px solid var(--line);font-size:.95rem';

function topBar(id, { owner = false, legacy = false } = {}) {
  const links = legacy
    ? `<a href="/api/v1/meetings/${esc(id)}/report.html" style="color:var(--accent)">Download report</a><a href="/api/v1/meetings/${esc(id)}/meeting.json" style="color:var(--accent)">meeting.json</a>`
    : owner
      ? `<a href="#share" style="color:var(--accent)">Share</a><button type="button" class="linkbtn" data-dl="report.html">Download report</button><button type="button" class="linkbtn" data-dl="meeting.json">meeting.json</button>`
      : '';
  return `<nav class="topbar" style="${NAV}">
<a href="/" style="font-weight:700;color:var(--ink);text-decoration:none">Board as a Service</a>
<span style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">${links}<a href="/" style="color:var(--accent)">Run your own meeting</a></span>
</nav>`;
}

const footerCss = '<style>.site-footer{max-width:920px;margin:0 auto;padding:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}.site-footer a{color:var(--accent)}.linkbtn{font:inherit;background:none;border:0;color:var(--accent);cursor:pointer;padding:0;text-decoration:underline}.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}.panel label{display:inline-flex;gap:6px;align-items:center;margin-right:14px}.tx{max-height:420px;overflow:auto;font-size:.95rem}.tx p{margin:4px 0}.tx .t{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:6px}.shares li{margin:6px 0}audio{width:100%;margin:8px 0}.small{color:var(--muted);font-size:.9rem}</style>';

function transcriptHtml(lines) {
  if (!lines?.length) return '';
  return `<div class="tx">${lines.map((l) => `<p><span class="t">${fmt(l.t)}</span><strong>${esc(l.speaker)}</strong>${l.source === 'chat' ? ' (chat)' : ''}: ${esc(l.text)}</p>`).join('')}</div>
<p class="small">Board lines are the exact text each member spoke. The founder's words were transcribed by self-hosted Whisper and may contain errors.</p>`;
}

/** Owner-only extras: recording, transcript, share links. */
function ownerExtras(view, { mediaUrl, transcript }) {
  const rec = view.recording;
  const recBlock = rec && !rec.deleted
    ? `<div class="panel"><audio controls preload="metadata" src="${esc(mediaUrl)}"></audio>
<p class="small">${fmt(rec.seconds)} · ${esc(rec.stored)} with a key only this service holds. Only you can play it, unless you share it below.</p>
${rec.c0mpute?.private_link ? c0mputeLinkHtml(rec.c0mpute.private_link, `${rec.c0mpute.warning} Deleting the recording here does not delete that c0mpute copy.`) : rec.c0mpute?.note ? `<p class="small">c0mpute copy: ${esc(rec.c0mpute.note)}.</p>` : ''}
<button type="button" class="linkbtn" id="delrec">Delete the recording and transcript</button></div>`
    : rec?.deleted
      ? `<p class="small">You deleted this recording. Its key is gone, so no copy on this server can be played again.${rec.c0mpute_copy_ref ? ` Its c0mpute copy (${esc(rec.c0mpute_copy_ref)}) still exists in c0mpute storage, and a private link that was already copied still opens it.` : ''}</p>`
      : view.voice
        ? '<p class="small">This call was not recorded.</p>'
        : '';
  return `${view.voice ? `<h2>Recording</h2>${recBlock}` : ''}
${transcript?.length ? `<h2>Transcript</h2>${transcriptHtml(transcript)}` : ''}
${sharePanel(view.id)}
<script>
(function(){
var id=${JSON.stringify(view.id)};
function key(){try{return localStorage.getItem('board-saas:key')}catch(e){return null}}
async function api(path,opts){opts=opts||{};var h={'content-type':'application/json'};var k=key();if(k)h.authorization='Bearer '+k;var r=await fetch(path,{method:opts.method||'GET',headers:h,body:opts.body?JSON.stringify(opts.body):undefined});var j={};try{j=await r.json()}catch(e){}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
var del=document.getElementById('delrec');if(del)del.onclick=async function(){if(!confirm(${JSON.stringify(`Delete the recording and transcript for good? Its key is destroyed and no copy on this server can be played again.${rec?.c0mpute?.private_link ? ' The c0mpute copy is not deleted: a private c0mpute link that was already copied keeps working.' : ''}`)}))return;try{await api('/api/v1/meetings/'+id+'/recording',{method:'DELETE'});location.reload()}catch(e){alert(e.message)}};
document.querySelectorAll('[data-dl]').forEach(function(b){b.onclick=async function(){var k=key();var r=await fetch('/api/v1/meetings/'+id+'/'+b.getAttribute('data-dl'),{headers:k?{authorization:'Bearer '+k}:{}});if(!r.ok){alert('download failed ('+r.status+')');return}var blob=await r.blob();var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='board-'+id+'-'+b.getAttribute('data-dl');a.click()}});
})();
</script>`;
}

/** The owner's report (served to the shell over the API, with their bearer). */
export function ownerReportPage(view, { mediaUrl = null, transcript = null } = {}) {
  return renderReport(view.meeting, { topBar: topBar(view.id, { owner: true }), footer: footerCss + allFooters(), extra: ownerExtras(view, { mediaUrl, transcript }) });
}

/** Pre-0.3.0 meetings: public by link, server-rendered as before. */
export function reportPage(view) {
  return renderReport(view.meeting, { topBar: topBar(view.id, { legacy: true }), footer: footerCss + allFooters() });
}

export function reportDownload(view) {
  return renderReport(view.meeting);
}

/** The meeting page shell: status, the live call's join box, sign-in for private meetings. */
export function statusPage(id, { coinpayUrl = null } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Board meeting</title>
<link rel="stylesheet" href="/style.css">
${PANEL_CSS}
<style>.join a.primary{display:inline-block;text-decoration:none;margin:6px 8px 6px 0}</style>
</head>
<body>
<main>
<p class="eyebrow"><a href="/" style="text-decoration:none">Board as a Service</a></p>
<h1 id="h">Board meeting</h1>
<p class="honest">The advisors are AI models on the c0mpute peer network, not real directors.</p>
<section class="card">
<div id="private" hidden><p><strong>This meeting is private.</strong> Only its owner can open it. If it is yours, ${coinpayUrl ? `<a class="primary" href="${esc(coinpayUrl)}" style="display:inline-block;text-decoration:none;margin:0 0 8px">Sign in with CoinPay</a> or ` : ''}<a href="/">sign in on the front page</a> with the same email in this browser, then reload this page. If someone shared it with you, ask them for a share link.</p></div>
<div id="call" class="join" hidden>
<p><strong>Your board is on a live call.</strong> <span id="recflag" class="rec" hidden>REC · this call is recorded</span></p>
<p id="callmsg">Join it in the PairUX desktop app or in any browser (it installs as an app). The board starts when you join.</p>
<p><a class="primary" id="joinlink" href="#" target="_blank" rel="noopener">Join the call on PairUX</a><button type="button" class="link" id="startnow">Start now without me</button></p>
<p class="small" id="joincode"></p>
</div>
<ol class="progress" id="steps">
<li data-s="checking">The chair checks your brief</li>
<li data-s="round1">Round 1: five independent verdicts <span id="r1"></span></li>
<li data-s="round2">Round 2: the debate <span id="r2"></span></li>
<li data-s="round3">Round 3: the chair writes the minutes</li>
</ol>
<p id="msg" class="status" role="status" aria-live="polite">Usually 2 to 6 minutes. This page updates by itself; you can close it and come back to this link, and we email you when the minutes are ready.</p>
<form id="clarify" hidden>
<p><strong>The chair needs a little more before the board can meet.</strong> This is asked once. Anything you leave blank becomes a written assumption.</p>
<div id="questions"></div>
<label for="answers">Your answers</label>
<textarea id="answers" rows="5" maxlength="3000"></textarea>
<button class="primary" type="submit">Send to the chair</button>
</form>
<p id="pay" hidden><a class="primary" id="paylink" href="#" style="display:inline-block;text-decoration:none">Pay $9 with CoinPay to start</a></p>
</section>
<div id="sharebox" hidden>${sharePanel(id)}</div>
<div id="briefbox" hidden><h2>Your brief</h2>
<pre style="white-space:pre-wrap" id="brief"></pre></div>
</main>
${allFooters()}
<script>
(function(){
var id=${JSON.stringify(id)};
var order=['checking','round1','round2','round3','done'];
var $=function(x){return document.getElementById(x)};
var msg=$('msg'),h=$('h'),cl=$('clarify'),pay=$('pay');
function key(){try{return localStorage.getItem('board-saas:key')}catch(e){return null}}
function auth(){var k=key();return k?{authorization:'Bearer '+k}:{}}
async function swapInReport(){
  var r=await fetch('/api/v1/meetings/'+id+'/page.html',{headers:auth()});
  if(!r.ok){location.reload();return}
  var html=await r.text();document.open();document.write(html);document.close();
}
function show(v){
  var stage=v.progress&&v.progress.stage||v.status;
  if(v.status==='done'){ if(v.private) swapInReport(); else location.reload(); return true}
  $('briefbox').hidden=false;$('brief').textContent=v.brief_text||'';
  if(v.voice&&v.status!=='failed'&&$('sharebox').hidden){$('sharebox').hidden=false;if(window.boardShareReload)window.boardShareReload()}
  if(v.status==='failed'){$('sharebox').hidden=true;h.textContent='The meeting could not finish';msg.textContent=v.error||'failed';msg.className='status bad';$('call').hidden=true;return true}
  cl.hidden=v.status!=='needs_clarification';pay.hidden=v.status!=='awaiting_payment';
  if(v.status==='awaiting_payment'){h.textContent='Waiting for payment';$('paylink').href=v.checkout_url;msg.textContent='Your free meeting is used. Once CoinPay confirms the $9 payment, the board starts by itself.';}
  if(v.status==='needs_clarification'&&v.clarify){h.textContent='One question from the chair';var q=$('questions');q.innerHTML='';v.clarify.questions.forEach(function(x){var p=document.createElement('p');p.textContent='\\u2022 '+x.question;q.appendChild(p)});}
  if(v.status==='queued'){msg.textContent='In the queue. The board starts as soon as a seat opens.';}
  var c=v.call;
  if(c&&c.join_url&&(c.status==='waiting'||c.status==='live')){
    $('call').hidden=false;$('joinlink').href=c.join_url;$('recflag').hidden=!c.recorded;
    $('joincode').textContent='Join code '+c.join_code+'. Sign in to PairUX first if you like; guests can speak too.';
    if(c.status==='live'){$('callmsg').textContent='The board is meeting on the call now ('+(c.started_because||'started')+'). Speak or type in the call chat to ask a question; the chair takes it between speakers.';$('startnow').hidden=true;h.textContent='The board is on the call';}
    else {h.textContent='Join your board';}
  } else if(c&&c.status==='failed'){$('call').hidden=true;msg.textContent='The live call could not start ('+(c.error||'error')+'), so the meeting continues as text.';}
  else if(v.voice&&(v.status==='queued'||v.status==='checking')){$('call').hidden=false;$('callmsg').textContent='The call opens as soon as the chair has checked your brief (a few seconds).';$('joinlink').hidden=true;$('startnow').hidden=true;}
  if(c&&c.join_url){$('joinlink').hidden=false;}
  var i=order.indexOf(stage);
  document.querySelectorAll('#steps li').forEach(function(li){var j=order.indexOf(li.getAttribute('data-s'));li.className=j<i?'done':(j===i?'now':'')});
  if(v.progress&&v.progress.of){var el=$(stage==='round1'?'r1':'r2');if(el)el.textContent='('+v.progress.done+'/'+v.progress.of+')';}
  return v.status==='needs_clarification';
}
async function poll(){
  try{
    var r=await fetch('/api/v1/meetings/'+id,{headers:auth()});
    if(r.status===401||r.status===403){$('private').hidden=false;$('steps').hidden=true;msg.hidden=true;h.textContent='Private board meeting';return}
    if(r.status===404){h.textContent='No meeting with that link';$('steps').hidden=true;msg.hidden=true;return}
    var v=await r.json();if(show(v))return;
  }catch(e){}
  setTimeout(poll,3000);
}
$('startnow').addEventListener('click',async function(){
  var r=await fetch('/api/v1/meetings/'+id+'/start',{method:'POST',headers:auth()});
  if(r.ok){$('startnow').hidden=true;$('callmsg').textContent='Starting now. You can still join at any time.';}
});
cl.addEventListener('submit',async function(ev){ev.preventDefault();
  var headers=Object.assign({'content-type':'application/json'},auth());
  var r=await fetch('/api/v1/meetings/'+id+'/clarify',{method:'POST',headers:headers,body:JSON.stringify({answers:$('answers').value})});
  var v=await r.json();if(!r.ok){msg.textContent=v.error;msg.className='status bad';return}
  cl.hidden=true;h.textContent='The board is meeting';msg.textContent='Thanks. The board is meeting now.';msg.className='status';poll();});
poll();
})();
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------ sharing, publishing, live

/** JSON for an inline <script>: user text (titles, labels) can never close the script tag. */
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';

/**
 * boardLive(videoEl, playbackUrl): play a c0mpute Live HLS stream. Safari and iOS play HLS
 * natively; everything else loads hls.js from jsDelivr on demand. These pages send no
 * Content-Security-Policy (only the OAuth pages do, and they never play media), so nothing had
 * to be widened for the script, the playlist or the segments. The stream may not be up yet when
 * the page opens, so a failed load is tried again every few seconds.
 * The URL handed in is the playback URL only. The stream key never reaches a page.
 */
const LIVE_JS = `function boardLive(el,url){if(el.getAttribute('data-url')===url)return;el.setAttribute('data-url',url);
var same=function(){return el.getAttribute('data-url')===url};
if(el.canPlayType('application/vnd.apple.mpegurl')){el.src=url;el.onerror=function(){setTimeout(function(){if(same()){el.src=url;el.load()}},4000)};return}
function go(){if(!window.Hls||!Hls.isSupported()){var p=document.createElement('p');p.className='small';p.textContent='This browser cannot play the live audio.';el.parentNode.insertBefore(p,el.nextSibling);return}
var h=new Hls();h.loadSource(url);h.attachMedia(el);h.on(Hls.Events.ERROR,function(_,d){if(d&&d.fatal){h.destroy();setTimeout(function(){if(same())go()},4000)}})}
if(window.Hls)return go();var s=document.createElement('script');s.src=${JSON.stringify(HLS_JS)};s.onload=go;document.head.appendChild(s)}`;

const LIVE_BOX = `<div id="livebox" hidden><p><strong>Live audio</strong> <span class="rec">LIVE</span></p>
<video id="live" controls playsinline style="width:100%;max-height:140px;background:#000;border-radius:8px"></video>
<p class="small">Audio only, a few seconds behind the call. Press play to listen.</p></div>`;

const PANEL_CSS = '<style>.linkbtn{font:inherit;background:none;border:0;color:var(--accent);cursor:pointer;padding:0;text-decoration:underline}.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}.panel label{display:inline-flex;gap:6px;align-items:center;margin:4px 14px 4px 0;font-weight:400}.panel input,.panel select{width:auto;font:inherit}.shares{padding-left:18px}.shares li{margin:6px 0;overflow-wrap:anywhere}.small{color:var(--muted);font-size:.9rem}.copy{font:inherit;background:var(--accent);color:var(--bg);border:0;border-radius:8px;padding:8px 16px;cursor:pointer;font-weight:600}.rec{display:inline-block;background:#b3412e;color:#fff;border-radius:999px;padding:2px 10px;font-size:.85rem;font-weight:700}.join{border:2px solid var(--accent,#2f5bd3);border-radius:12px;padding:14px 16px;margin:12px 0}</style>';

/**
 * The owner's sharing controls: invites by role, and the public switch. Self-contained (its own
 * script), used on the finished report and on the meeting page while a voice meeting is pending
 * or running. It reads the meeting over the API with the owner's key, so nothing is baked in.
 */
function sharePanel(id) {
  return `<h2 id="share">Share and invite</h2>
<p id="shareintro">This meeting is private: only you can open it. An invite link lets whoever has it see what its role allows, until it expires or you revoke it.</p>
<div class="panel"><form id="shareform">
<label>Role <select name="role"></select></label>
<label>For <input name="label" type="text" maxlength="80" placeholder="who it is for (optional)"></label>
<label id="dlrow" hidden><input type="checkbox" name="dl"> Allow downloading the recording</label>
<label>Expires <select name="exp"><option value="never">never</option><option value="24h">in 24 hours</option><option value="7d">in 7 days</option><option value="30d">in 30 days</option></select></label>
<button class="copy" type="submit">Create share link</button></form>
<p class="small" id="rolehelp"></p>
<p id="sharemsg" class="small" role="status" aria-live="polite"></p>
<ul class="shares" id="shares"></ul></div>
<div class="panel"><p><strong>Public page.</strong> <span id="pubstate">This meeting is private.</span></p>
<label id="pubrecrow" hidden><input type="checkbox" id="pubrec"> Include the recording on the public page</label>
<p><button type="button" class="copy" id="pubbtn">Make this meeting public</button></p>
<p class="small">A public meeting gets its own page, is listed on <a href="/meetings">the public meetings page</a> and can be found by search engines. While it runs, the public page plays the live audio; afterwards it shows the report. Your company data is never shown. You can make it private again at any time.</p></div>
<script>
(function(){
var id=${js(id)};
var HELP={view:'View: the report only.',listen:'Listen: the report, the live audio while the meeting runs, and the recording afterwards.',join:'Join: everything in Listen, plus the PairUX link to take part while the call is open. The link is hidden once the meeting ends.'};
function key(){try{return localStorage.getItem('board-saas:key')}catch(e){return null}}
async function api(path,opts){opts=opts||{};var h={'content-type':'application/json'};var k=key();if(k)h.authorization='Bearer '+k;var r=await fetch(path,{method:opts.method||'GET',headers:h,body:opts.body?JSON.stringify(opts.body):undefined});var j={};try{j=await r.json()}catch(e){}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
var f=document.getElementById('shareform'),list=document.getElementById('shares'),msg=document.getElementById('sharemsg'),M=null;
function roles(){if(!M)return[];if(M.status==='done')return['view','listen'];return M.voice?['listen','join']:[]}
function paint(){
  var rs=roles(),sel=f.role,cur=sel.value;sel.innerHTML='';
  rs.forEach(function(r){var o=document.createElement('option');o.value=r;o.textContent=r;sel.appendChild(o)});
  if(rs.indexOf(cur)>=0)sel.value=cur;
  f.hidden=!rs.length;
  document.getElementById('dlrow').hidden=sel.value==='view'||!M||!M.voice;
  document.getElementById('rolehelp').textContent=rs.length?(HELP[sel.value]||''):'Invites open once the report is ready.';
  var pub=M&&M.visibility==='public',ps=document.getElementById('pubstate');ps.textContent='';
  if(pub){ps.appendChild(document.createTextNode('This meeting is public at '));var a=document.createElement('a');a.href=M.public_url;a.textContent=M.public_url;ps.appendChild(a)}else ps.textContent='This meeting is private.';
  document.getElementById('pubbtn').textContent=pub?'Make this meeting private':'Make this meeting public';
  document.getElementById('pubrecrow').hidden=!(M&&M.voice);
  document.getElementById('pubrec').checked=!!(M&&M.public_recording);
}
async function load(){
  try{M=await api('/api/v1/meetings/'+id);paint();
    var j=await api('/api/v1/meetings/'+id+'/shares');list.innerHTML='';
    j.shares.forEach(function(s){var li=document.createElement('li');var state=s.revoked?'revoked':(s.expired?'expired':'live');
      li.appendChild(document.createTextNode(state+' \\u00b7 '+s.role+(s.label?' \\u00b7 for '+s.label:'')+(s.allow_download?' \\u00b7 download allowed':'')+' \\u00b7 '+(s.expires_at?'expires '+s.expires_at.slice(0,10):'no expiry')+' '));
      var a=document.createElement('a');a.href=s.url;a.textContent=s.url;li.appendChild(a);
      if(!s.revoked){var b=document.createElement('button');b.type='button';b.className='linkbtn';b.textContent='revoke';b.onclick=async function(){await api('/api/v1/shares/'+s.id,{method:'DELETE'});load()};li.appendChild(document.createTextNode(' '));li.appendChild(b)}
      list.appendChild(li)})
  }catch(e){msg.textContent=e.message}}
f.role.addEventListener('change',paint);
f.addEventListener('submit',async function(ev){ev.preventDefault();try{var s=await api('/api/v1/meetings/'+id+'/shares',{method:'POST',body:{role:f.role.value,label:f.label.value,allow_download:!!f.dl.checked,expires:f.exp.value}});msg.textContent='Share link created ('+s.role+'): '+s.url;try{await navigator.clipboard.writeText(s.url);msg.textContent+=' (copied)'}catch(e){}f.label.value='';load()}catch(e){msg.textContent=e.message}});
document.getElementById('pubbtn').onclick=async function(){var pub=M&&M.visibility==='public';if(!pub&&!confirm('Make this meeting public? Anyone will be able to open its page, and it will be listed and indexable.'))return;try{M=await api('/api/v1/meetings/'+id,{method:'PATCH',body:{visibility:pub?'private':'public',include_recording:document.getElementById('pubrec').checked}});paint()}catch(e){msg.textContent=e.message}};
document.getElementById('pubrec').onchange=async function(){if(!(M&&M.visibility==='public'))return;try{M=await api('/api/v1/meetings/'+id,{method:'PATCH',body:{visibility:'public',include_recording:this.checked}});paint()}catch(e){msg.textContent=e.message}};
window.boardShareReload=load;
load();
})();
</script>`;
}

/** The private c0mpute link, with the warning it must never be shown without. */
function c0mputeLinkHtml(link, warning) {
  return `<p><strong>Private c0mpute link.</strong> <a href="${esc(link)}" rel="noopener noreferrer">Open the recording on c0mpute</a></p>
<p class="small">${esc(warning)}</p>`;
}

function recordingHtml({ mediaUrl, allowDownload, transcript, c0mputeLink = null, warning = '' }) {
  return `<h2>Recording</h2><div class="panel"><audio controls preload="metadata" ${allowDownload ? '' : 'controlslist="nodownload" oncontextmenu="return false"'} src="${esc(mediaUrl)}"></audio>${allowDownload ? `<p><a href="${esc(mediaUrl)}&download=1">Download the recording</a></p>` : ''}${c0mputeLink ? c0mputeLinkHtml(c0mputeLink, warning) : ''}</div>${transcript?.length ? `<h2>Transcript</h2>${transcriptHtml(transcript)}` : ''}`;
}

const ROLE_NOTE = { view: 'read only', listen: 'report and recording', join: 'report and recording' };

/** What a share link shows once the meeting is done: the report, and for listen/join the recording + transcript. */
export function sharePage(shared, { mediaUrl, warning = '' }) {
  const { share, role, view, transcript, c0mputeLink } = shared;
  const rec = shared.recordingAvailable ? recordingHtml({ mediaUrl, allowDownload: !!share.allow_download, transcript, c0mputeLink, warning }) : '';
  const note = `<p class="small">Shared with you by the meeting owner (${ROLE_NOTE[role] ?? 'read only'})${share.expires_at ? `, until ${esc(new Date(share.expires_at).toISOString().slice(0, 10))}` : ''}.</p>`;
  return renderReport(view.meeting, { topBar: topBar(''), footer: footerCss + allFooters(), extra: note + rec, head: '<meta name="robots" content="noindex">' });
}

/** A public meeting's finished report. Indexable: no noindex here. */
export function publicReportPage(pub, { mediaUrl }) {
  const rec = pub.recordingAvailable ? recordingHtml({ mediaUrl, allowDownload: false, transcript: pub.transcript }) : '';
  const note = '<p class="small">Published by the meeting owner. <a href="/meetings">More public board meetings</a></p>';
  const m = pub.view.meeting;
  const head = `<link rel="canonical" href="${esc(pub.url)}"><meta name="description" content="${esc(`Board meeting minutes: ${m.minutes?.recommendation ?? m.title ?? ''}`.slice(0, 200))}">`;
  return renderReport(m, { topBar: topBar(''), footer: footerCss + allFooters(), extra: note + rec, head });
}

/**
 * Before the report exists: the page an invite or a public link opens while the meeting is
 * scheduled or running. It shows the state, the live audio (listen, join and public), and the
 * PairUX join button (join only), and re-reads its state from the server every few seconds, so
 * a revoked invite or an ended call takes the player and the button away.
 */
export function audiencePage({ state, stateUrl, kind = 'share', share = null, indexable = false, canonical = null }) {
  const who = kind === 'public'
    ? 'This is a public board meeting. <a href="/meetings">More public board meetings</a>'
    : `You were invited by the meeting owner${share?.expires_at ? ` (this link works until ${esc(new Date(share.expires_at).toISOString().slice(0, 10))})` : ''}.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${indexable ? (canonical ? `<link rel="canonical" href="${esc(canonical)}">` : '') : '<meta name="robots" content="noindex">'}
<title>${esc(state.title)}</title>
<link rel="stylesheet" href="/style.css">
${PANEL_CSS}
</head>
<body>
<main>
<p class="eyebrow"><a href="/" style="text-decoration:none">Board as a Service</a></p>
<h1>${esc(state.title)}</h1>
<p class="honest">The advisors are AI models on the c0mpute peer network, not real directors.</p>
<section class="card">
<p id="st" class="status" role="status" aria-live="polite"></p>
${LIVE_BOX}
<div id="joinbox" class="join" hidden>
<p><strong>You are invited to take part.</strong> Join the call in the PairUX desktop app or in any browser. You can speak or type a question; the chair takes it between speakers.</p>
<p><a class="primary" id="joinlink" href="#" target="_blank" rel="noopener" style="display:inline-block;text-decoration:none">Join the call on PairUX</a></p>
<p class="small" id="joincode"></p>
</div>
</section>
<p class="small">${who}</p>
</main>
${allFooters()}
<script>
${LIVE_JS}
(function(){
var S=${js(state)},U=${js(stateUrl)};
var $=function(x){return document.getElementById(x)};
function paint(){
  var t=S.status==='live'?(S.voice?'The board is meeting now.':'The board is meeting now. The report appears here when it ends.'):'This meeting has not started yet. This page updates by itself.';
  if(S.status==='live'&&S.voice&&S.role!=='view'&&!S.live)t+=' Live audio is not available right now.';
  $('st').textContent=t;
  $('livebox').hidden=!S.live;if(S.live)boardLive($('live'),S.live.playback_url);else{var v=$('live');v.removeAttribute('data-url');v.removeAttribute('src')}
  $('joinbox').hidden=!S.join;if(S.join){$('joinlink').href=S.join.join_url;$('joincode').textContent=S.join.join_code?'Join code '+S.join.join_code+'. This call is recorded if the owner chose to record it; the chair says so when you join.':''}
}
async function poll(){
  try{var r=await fetch(U,{cache:'no-store'});
    if(r.status===404){$('st').textContent='This link is no longer available.';$('livebox').hidden=true;$('joinbox').hidden=true;return}
    if(r.ok){S=await r.json();if(S.status==='ended'){location.reload();return}paint()}
  }catch(e){}
  setTimeout(poll,4000);
}
paint();setTimeout(poll,4000);
})();
</script>
</body>
</html>`;
}

/** /meetings: every public meeting, newest first. */
export function meetingsIndexPage(list, { canonical }) {
  const label = { live: 'live now', scheduled: 'scheduled', ended: '' };
  const items = list.length
    ? `<ul class="plist">${list.map((m) => `<li><a href="${esc(m.url)}">${esc(m.title)}</a> <span class="small">${esc(m.date.slice(0, 10))}${label[m.status] ? ` · ${label[m.status]}` : ''}${m.voice ? ' · voice' : ''}</span></li>`).join('')}</ul>`
    : '<p>No public meetings yet. Meetings are private unless their owner publishes them.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Public board meetings | Board as a Service</title>
<meta name="description" content="Board meetings their owners chose to publish: five AI advisors debate a decision and a chair writes the minutes.">
<link rel="canonical" href="${esc(canonical)}">
<link rel="stylesheet" href="/style.css">
<style>.plist{list-style:none;padding:0}.plist li{padding:10px 0;border-bottom:1px solid var(--line)}.small{color:var(--muted);font-size:.9rem}</style>
</head>
<body>
<main>
<p class="eyebrow"><a href="/" style="text-decoration:none">Board as a Service</a></p>
<h1>Public board meetings</h1>
<p class="honest">The advisors are AI models on the c0mpute peer network, not real directors.</p>
<p>Meetings are private by default. These are the ones their owners chose to publish, newest first.</p>
${items}
<p><a href="/">Run your own board meeting</a></p>
</main>
${allFooters()}
</body>
</html>`;
}

// ------------------------------------------------------------------ account

/**
 * /account: a shell like the meeting page. Nothing private is in it: it reads the account and the
 * meetings over the API with the key the browser keeps (from the email code or Sign in with
 * CoinPay), and offers Sign in with CoinPay, Connect CoinPay and Disconnect.
 */
export function accountPage({ coinpayUrl = null, coinpayEnabled = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Your account</title>
<link rel="stylesheet" href="/style.css">
${PANEL_CSS}
<style>.mlist{list-style:none;padding:0;margin:0}.mlist li{padding:10px 0;border-top:1px solid var(--line)}.mlist li:first-child{border-top:0}.mlist .small{display:block}.cpbtn{display:inline-block;text-decoration:none}</style>
</head>
<body>
<main>
<p class="eyebrow"><a href="/" style="text-decoration:none">Board as a Service</a></p>
<h1 id="h">Your account</h1>
<section class="card" id="out" hidden>
<h2>Sign in</h2>
<p>Sign in to see your meetings, reports and recordings.</p>
${coinpayUrl ? `<p><a class="primary cpbtn" href="${esc(coinpayUrl)}">Sign in with CoinPay</a></p>` : ''}
<p class="small">${coinpayUrl ? 'Or sign in' : 'Sign in'} with your email on <a href="/">the front page</a> (we send a 6-digit code). Signing in with CoinPay makes its own account unless you first connect CoinPay to your email account here, while signed in.</p>
</section>
<section class="card" id="in" hidden>
<h2>Account</h2>
<p id="who"></p>
<p id="plan" class="small"></p>
<p id="voice" class="small"></p>
<p id="pass" class="small"></p>
<div class="panel" id="cp" ${coinpayEnabled ? '' : 'hidden'}><p><strong>CoinPay.</strong> <span id="cpstate"></span></p>
<p><button type="button" class="copy" id="cpconnect" hidden>Connect CoinPay</button> <button type="button" class="linkbtn" id="cpdisconnect" hidden>Disconnect CoinPay</button></p>
<p class="small">Connected, you can sign in to this account with CoinPay, and an active <a href="https://coinpayportal.com/pass">Profullstack Pass</a> covers your board meetings. Board as a Service never uses your CoinPay email to find or change an account.</p>
<p id="cpmsg" class="small" role="status" aria-live="polite"></p></div>
<p><button type="button" class="linkbtn" id="signout">Sign out in this browser</button></p>
</section>
<section id="mbox" hidden>
<h2>Your meetings</h2>
<ul class="mlist" id="meetings"></ul>
<p class="small" id="nomeetings" hidden>No meetings yet. <a href="/">Convene the board</a>.</p>
</section>
</main>
${allFooters()}
<script>
(function(){
var $=function(x){return document.getElementById(x)};
function key(){try{return localStorage.getItem('board-saas:key')}catch(e){return null}}
async function api(path,opts){opts=opts||{};var h={'content-type':'application/json'};var k=key();if(k)h.authorization='Bearer '+k;var r=await fetch(path,{method:opts.method||'GET',headers:h,body:opts.body?JSON.stringify(opts.body):undefined});var j={};try{j=await r.json()}catch(e){}if(!r.ok){var err=new Error(j.error||('HTTP '+r.status));err.status=r.status;throw err}return j}
function out(){$('out').hidden=false;$('in').hidden=true;$('mbox').hidden=true}
function line(el,text){el.textContent=text||'';el.hidden=!text}
async function load(){
  if(!key())return out();
  var a;try{a=await api('/api/v1/account')}catch(e){if(e.status===401){try{localStorage.removeItem('board-saas:key')}catch(x){}}return out()}
  $('out').hidden=true;$('in').hidden=false;
  if(a.admin){line($('who'),'Signed in with the admin key.');$('cp').hidden=true;return}
  line($('who'),'Signed in as '+(a.email||a.name||'your account')+'.');
  var c0=a.c0mpute||{};
  line($('plan'),a.pass&&a.pass.active?'Board meetings are covered by your Profullstack Pass until '+a.pass.until.slice(0,10)+'.':(a.free_meeting_available?'Your free meeting is ready.':(a.credits>0?a.credits+' prepaid meeting(s) left.':(c0.connected?'Meetings are charged as you go to your c0mpute balance'+(typeof c0.balance_usd==='number'?' ($'+c0.balance_usd.toFixed(2)+' now)':'')+': Claude Opus 5.5 at our Anthropic cost plus 20%. Top up with CoinPay: '+c0.top_up_url:'Connect your c0mpute account (your CoinPay account) to pay for meetings as you go: Claude Opus 5.5 at our Anthropic cost plus 20%. Use the connect c0mpute link on the front page.'))));
  line($('voice'),a.voice&&a.voice.summary?a.voice.summary+'.':'');
  line($('pass'),a.pass&&a.pass.active?'':'No active Profullstack Pass. A Pass ($99 kept in your own CoinPay wallet) gives a free month on every Profullstack site: coinpayportal.com/pass, then sign in with CoinPay again.');
  var c=a.coinpay||{};
  $('cpstate').textContent=c.linked?('Connected'+(c.linked_at?' since '+c.linked_at.slice(0,10):'')+(c.sign_in_only?'. This account was made by Sign in with CoinPay.':'.')):'Not connected.';
  $('cpconnect').hidden=!!c.linked;$('cpdisconnect').hidden=!c.linked||!!c.sign_in_only;
  if(/[?&]coinpay=connected/.test(location.search))$('cpmsg').textContent='CoinPay is connected to this account.';
  try{var m=await api('/api/v1/meetings');var ul=$('meetings');ul.innerHTML='';$('mbox').hidden=false;$('nomeetings').hidden=m.meetings.length>0;
    m.meetings.forEach(function(x){var li=document.createElement('li');var aa=document.createElement('a');aa.href='/m/'+encodeURIComponent(x.id);aa.textContent=x.brief||x.id;li.appendChild(aa);var s=document.createElement('span');s.className='small';s.textContent=x.created_at.slice(0,10)+' · '+x.status+' · '+x.visibility;li.appendChild(s);ul.appendChild(li)})}catch(e){}
}
$('cpconnect').onclick=async function(){this.disabled=true;try{var r=await api('/api/v1/auth/coinpay/link',{method:'POST'});location.assign(r.url)}catch(e){$('cpmsg').textContent=e.message;this.disabled=false}};
$('cpdisconnect').onclick=async function(){if(!confirm('Disconnect CoinPay from this account? You can connect it again later.'))return;try{await api('/api/v1/auth/coinpay',{method:'DELETE'});$('cpmsg').textContent='CoinPay is disconnected.';load()}catch(e){$('cpmsg').textContent=e.message}};
$('signout').onclick=function(){try{localStorage.removeItem('board-saas:key')}catch(e){}load()};
load();
})();
</script>
</body>
</html>`;
}
