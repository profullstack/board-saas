// Server-rendered pages: the meeting status page (polls the API) and the report page.
import { allFooters } from './footers.js';
import { renderReport } from './render-report.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function topBar(id) {
  return `<nav class="topbar" style="display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;max-width:920px;margin:0 auto;padding:12px 16px;border-bottom:1px solid var(--line);font-size:.95rem">
<a href="/" style="font-weight:700;color:var(--ink);text-decoration:none">Board as a Service</a>
<span style="display:flex;gap:14px;flex-wrap:wrap"><a href="/api/v1/meetings/${esc(id)}/report.html" style="color:var(--accent)">Download report</a><a href="/api/v1/meetings/${esc(id)}/meeting.json" style="color:var(--accent)">meeting.json</a><a href="/" style="color:var(--accent)">Run your own meeting</a></span>
</nav>`;
}

const footerCss = '<style>.site-footer{max-width:920px;margin:0 auto;padding:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}.site-footer a{color:var(--accent)}</style>';

export function reportPage(view) {
  return renderReport(view.meeting, { topBar: topBar(view.id), footer: footerCss + allFooters() });
}

export function reportDownload(view) {
  return renderReport(view.meeting);
}

export function statusPage(view) {
  const brief = esc(view.brief_text);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Board meeting in progress</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
<p class="eyebrow"><a href="/" style="text-decoration:none">Board as a Service</a></p>
<h1 id="h">The board is meeting</h1>
<p class="honest">The advisors are AI models on the c0mpute peer network, not real directors.</p>
<section class="card">
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
<h2>Your brief</h2>
<pre style="white-space:pre-wrap">${brief}</pre>
</main>
${allFooters()}
<script>
(function(){
var id=${JSON.stringify(view.id)};
var order=['checking','round1','round2','round3','done'];
var msg=document.getElementById('msg'),h=document.getElementById('h'),cl=document.getElementById('clarify'),pay=document.getElementById('pay');
function key(){try{return localStorage.getItem('board-saas:key')}catch(e){return null}}
function show(v){
  var stage=v.progress&&v.progress.stage||v.status;
  if(v.status==='done'){location.reload();return true}
  if(v.status==='failed'){h.textContent='The meeting could not finish';msg.textContent=v.error||'failed';msg.className='status bad';return true}
  cl.hidden=v.status!=='needs_clarification';pay.hidden=v.status!=='awaiting_payment';
  if(v.status==='awaiting_payment'){h.textContent='Waiting for payment';document.getElementById('paylink').href=v.checkout_url;msg.textContent='Your free meeting is used. Once CoinPay confirms the $9 payment, the board starts by itself.';}
  if(v.status==='needs_clarification'&&v.clarify){h.textContent='One question from the chair';var q=document.getElementById('questions');q.innerHTML='';v.clarify.questions.forEach(function(x){var p=document.createElement('p');p.textContent='\\u2022 '+x.question;q.appendChild(p)});}
  if(v.status==='queued'){msg.textContent='In the queue. The board starts as soon as a seat opens.';}
  var i=order.indexOf(stage);
  document.querySelectorAll('#steps li').forEach(function(li){var j=order.indexOf(li.getAttribute('data-s'));li.className=j<i?'done':(j===i?'now':'')});
  if(v.progress&&v.progress.of){var el=document.getElementById(stage==='round1'?'r1':'r2');if(el)el.textContent='('+v.progress.done+'/'+v.progress.of+')';}
  return v.status==='needs_clarification';
}
async function poll(){
  try{var r=await fetch('/api/v1/meetings/'+id);var v=await r.json();if(show(v))return;}catch(e){}
  setTimeout(poll,4000);
}
cl.addEventListener('submit',async function(ev){ev.preventDefault();
  var headers={'content-type':'application/json'};var k=key();if(k)headers.authorization='Bearer '+k;
  var r=await fetch('/api/v1/meetings/'+id+'/clarify',{method:'POST',headers:headers,body:JSON.stringify({answers:document.getElementById('answers').value})});
  var v=await r.json();if(!r.ok){msg.textContent=v.error;msg.className='status bad';return}
  cl.hidden=true;h.textContent='The board is meeting';msg.textContent='Thanks. The board is meeting now.';msg.className='status';poll();});
poll();
})();
</script>
</body>
</html>`;
}
