// Server-rendered pages: the meeting page (status, live call, then the report), the owner's
// report with its private extras (recording, transcript, share links), and share-link pages.
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
<button type="button" class="linkbtn" id="delrec">Delete the recording and transcript</button></div>`
    : rec?.deleted
      ? '<p class="small">You deleted this recording. Its key is gone, so no copy can be played again.</p>'
      : view.voice
        ? '<p class="small">This call was not recorded.</p>'
        : '';
  return `${view.voice ? `<h2>Recording</h2>${recBlock}` : ''}
${transcript?.length ? `<h2>Transcript</h2>${transcriptHtml(transcript)}` : ''}
<h2 id="share">Share</h2>
<p>This report is private: only you can open it. A share link lets anyone who has it read the report${view.voice ? ' and, if you choose, play the recording' : ''}. You can revoke a link at any time.</p>
<div class="panel"><form id="shareform">
${view.voice && rec && !rec.deleted ? '<label><input type="checkbox" name="rec"> Include the recording and transcript</label><label><input type="checkbox" name="dl"> Allow downloading the recording</label>' : ''}
<label>Expires <select name="exp"><option value="never">never</option><option value="7d">in 7 days</option><option value="30d">in 30 days</option></select></label>
<button class="copy" type="submit">Create share link</button></form>
<p id="sharemsg" class="small" role="status" aria-live="polite"></p>
<ul class="shares" id="shares"></ul></div>
<script>
(function(){
var id=${JSON.stringify(view.id)};
function key(){try{return localStorage.getItem('board-saas:key')}catch(e){return null}}
async function api(path,opts){opts=opts||{};var h={'content-type':'application/json'};var k=key();if(k)h.authorization='Bearer '+k;var r=await fetch(path,{method:opts.method||'GET',headers:h,body:opts.body?JSON.stringify(opts.body):undefined});var j={};try{j=await r.json()}catch(e){}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
var list=document.getElementById('shares'),msg=document.getElementById('sharemsg');
async function load(){try{var j=await api('/api/v1/meetings/'+id+'/shares');list.innerHTML='';j.shares.forEach(function(s){var li=document.createElement('li');var state=s.revoked?'revoked':(s.expired?'expired':'live');li.appendChild(document.createTextNode(state+' · '+(s.include_recording?'with recording':'report only')+(s.allow_download?' · download allowed':'')+' · '+(s.expires_at?'expires '+s.expires_at.slice(0,10):'no expiry')+' '));var a=document.createElement('a');a.href=s.url;a.textContent=s.url;li.appendChild(a);if(!s.revoked){var b=document.createElement('button');b.type='button';b.className='linkbtn';b.textContent=' revoke';b.onclick=async function(){await api('/api/v1/shares/'+s.id,{method:'DELETE'});load()};li.appendChild(document.createTextNode(' '));li.appendChild(b)}list.appendChild(li)})}catch(e){msg.textContent=e.message}}
document.getElementById('shareform').addEventListener('submit',async function(ev){ev.preventDefault();var f=ev.target;try{var s=await api('/api/v1/meetings/'+id+'/shares',{method:'POST',body:{include_recording:!!(f.rec&&f.rec.checked),allow_download:!!(f.dl&&f.dl.checked),expires:f.exp.value}});msg.textContent='Share link created: '+s.url;try{await navigator.clipboard.writeText(s.url);msg.textContent+=' (copied)'}catch(e){}load()}catch(e){msg.textContent=e.message}});
var del=document.getElementById('delrec');if(del)del.onclick=async function(){if(!confirm('Delete the recording and transcript for good? Its key is destroyed and no copy can be played again.'))return;try{await api('/api/v1/meetings/'+id+'/recording',{method:'DELETE'});location.reload()}catch(e){alert(e.message)}};
document.querySelectorAll('[data-dl]').forEach(function(b){b.onclick=async function(){var k=key();var r=await fetch('/api/v1/meetings/'+id+'/'+b.getAttribute('data-dl'),{headers:k?{authorization:'Bearer '+k}:{}});if(!r.ok){alert('download failed ('+r.status+')');return}var blob=await r.blob();var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='board-'+id+'-'+b.getAttribute('data-dl');a.click()}});
load();
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

/** What a share link shows: the report, and the recording + transcript if the owner included them. */
export function sharePage(view, { share, mediaUrl, transcript }) {
  const rec = share.include_recording && view.recordingAvailable
    ? `<h2>Recording</h2><div class="panel"><audio controls preload="metadata" ${share.allow_download ? '' : 'controlslist="nodownload" oncontextmenu="return false"'} src="${esc(mediaUrl)}"></audio>${share.allow_download ? `<p><a href="${esc(mediaUrl)}&download=1">Download the recording</a></p>` : ''}</div>${transcript?.length ? `<h2>Transcript</h2>${transcriptHtml(transcript)}` : ''}`
    : '';
  const note = `<p class="small">Shared with you by the meeting owner (read only)${share.expires_at ? `, until ${esc(new Date(share.expires_at).toISOString().slice(0, 10))}` : ''}.</p>`;
  return renderReport(view.meeting, { topBar: topBar(view.id), footer: footerCss + allFooters(), extra: note + rec });
}

export function reportDownload(view) {
  return renderReport(view.meeting);
}

/** The meeting page shell: status, the live call's join box, sign-in for private meetings. */
export function statusPage(id) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Board meeting</title>
<link rel="stylesheet" href="/style.css">
<style>.join{border:2px solid var(--accent,#2f5bd3);border-radius:12px;padding:14px 16px;margin:12px 0}.join a.primary{display:inline-block;text-decoration:none;margin:6px 8px 6px 0}.rec{display:inline-block;background:#b3412e;color:#fff;border-radius:999px;padding:2px 10px;font-size:.85rem;font-weight:700}</style>
</head>
<body>
<main>
<p class="eyebrow"><a href="/" style="text-decoration:none">Board as a Service</a></p>
<h1 id="h">Board meeting</h1>
<p class="honest">The advisors are AI models on the c0mpute peer network, not real directors.</p>
<section class="card">
<div id="private" hidden><p><strong>This meeting is private.</strong> Only its owner can open it. If it is yours, <a href="/">sign in on the front page</a> with the same email in this browser, then reload this page. If someone shared it with you, ask them for a share link.</p></div>
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
  if(v.status==='failed'){h.textContent='The meeting could not finish';msg.textContent=v.error||'failed';msg.className='status bad';$('call').hidden=true;return true}
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
