// Render a boardroom meeting.json into one self-contained interactive HTML report.
// Ported from profullstack/boardroom scripts/render-report.mjs (same markup and styles),
// wrapped as a function, plus an honest "AI advisors" line and optional top bar / footer.
//   renderReport(meeting, { topBar, footer }) -> html string
//   node src/render-report.js meeting.json [report.html]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function renderReport(m, { topBar = "", footer = "", extra = "" } = {}) {
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const experts = m.experts ?? [];
const nameOf = (id) => experts.find((e) => e.id === id)?.name ?? id;
const list = (items) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");

const verdictTabs = experts
  .map((e, i) => `<button role="tab" id="tab-${esc(e.id)}" aria-controls="panel-${esc(e.id)}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(e.name)}</button>`)
  .join("");
const verdictPanels = experts
  .map((e, i) => {
    const v = (m.verdicts ?? []).find((x) => x.expert === e.id) ?? {};
    return `<section role="tabpanel" id="panel-${esc(e.id)}" aria-labelledby="tab-${esc(e.id)}" ${i === 0 ? "" : "hidden"}>
  <p class="lens">${esc(e.lens)}</p>
  <h3 class="call">${esc(v.call)}</h3>
  <ol class="reasons">${(v.reasons ?? []).map((r) => `<li>${esc(r)}</li>`).join("")}</ol>
  <div class="watch"><strong>Watch out for</strong><p>${esc(v.watch_out)}</p></div>
</section>`;
  })
  .join("");

const rel = (arr, cls, label) =>
  arr?.length
    ? `<div class="rel ${cls}"><span class="tag">${label}</span>${arr
        .map((a) => `<p><strong>${esc(nameOf(a.with))}</strong>: ${esc(a.why)}</p>`)
        .join("")}</div>`
    : "";
const debateCards = (m.debate ?? [])
  .map(
    (d) => `<article class="card">
  <header><h3>${esc(nameOf(d.expert))}</h3><span class="badge ${d.changed_mind ? "changed" : "held"}">${d.changed_mind ? "Changed mind" : "Held position"}</span></header>
  <blockquote>${esc(d.reply)}</blockquote>
  ${rel(d.agrees, "agree", "Agrees with")}
  ${rel(d.disagrees, "disagree", "Disagrees with")}
  <p class="final"><strong>Final position:</strong> ${esc(d.position)}</p>
</article>`
  )
  .join("");

const mn = m.minutes ?? {};
const voteRows = (mn.vote ?? [])
  .map((v) => `<tr><td>${esc(nameOf(v.expert))}</td><td>${esc(v.initial)}</td><td>${esc(v.final)}</td><td>${v.changed ? "Yes" : "No"}</td></tr>`)
  .join("");
const clashes = (mn.clashes ?? [])
  .map((c) => `<li><strong>${esc(c.topic)}</strong>: ${esc(c.sides)}. <em>Crux:</em> ${esc(c.crux)}</li>`)
  .join("");

const qaRows = (m.qa ?? [])
  .map(
    (q) => `<article class="card"><header><h3>${esc(q.from || "Founder")} asked${q.via === "chat" ? " in the chat" : " on the call"}</h3><span class="badge">${q.routed_to === "all" ? "Whole board" : esc(nameOf(q.routed_to))}</span></header>
  <blockquote>${esc(q.question)}</blockquote>
  ${(q.answers ?? []).length ? q.answers.map((a) => `<p><strong>${esc(nameOf(a.expert))}</strong>: ${esc(a.text)}</p>`).join("") : "<p><em>No answer came back from the network in time.</em></p>"}
</article>`
  )
  .join("");
const vc = m.voice;
const voiceBlock = vc
  ? `<h2>Founder Q&amp;A</h2>
${vc.held ? "" : `<p class="question">${esc(vc.error)}</p>`}
${qaRows ? `<div class="cards">${qaRows}</div>` : `<p>${vc.held ? "No questions were asked during the call." : ""}</p>`}
<p class="ai-note" style="margin-top:12px">Live voice meeting on PairUX${vc.attendees?.length ? ` with ${esc(vc.attendees.join(", "))}` : ""}${vc.recorded ? ", recorded (private to the meeting owner)" : ""}. ${esc(vc.speech || "")} ${esc(vc.pricing || "")}</p>
${(vc.notes ?? []).length ? `<ul>${vc.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`
  : "";

const b = m.brief ?? {};
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title || "Board meeting")}</title>
<style>
:root{--bg:#f7f6f3;--surface:#fff;--ink:#1d1d1b;--muted:#5f5e5a;--line:#e3e1db;--accent:#2f5bd3;--agree:#1f7a4d;--disagree:#b3412e;--warn:#fbf3e2;--warn-line:#e7c77a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--surface:#1f1f1d;--ink:#ecebe6;--muted:#a3a29c;--line:#34332f;--accent:#8aa8ff;--agree:#6cc79a;--disagree:#f08a76;--warn:#2b2516;--warn-line:#7a6430}}
:root[data-theme="dark"]{--bg:#141413;--surface:#1f1f1d;--ink:#ecebe6;--muted:#a3a29c;--line:#34332f;--accent:#8aa8ff;--agree:#6cc79a;--disagree:#f08a76;--warn:#2b2516;--warn-line:#7a6430}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 4px}
h2{font-size:1.25rem;margin:40px 0 12px;padding-top:8px;border-top:1px solid var(--line)}
.meta{color:var(--muted);margin:0 0 20px}
.brief{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 20px}
.brief dt{font-weight:600;margin-top:8px}.brief dd{margin:2px 0 0}.brief ul{margin:4px 0;padding-left:20px}
[role=tablist]{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--line)}
[role=tab]{font:inherit;background:none;border:0;border-bottom:3px solid transparent;color:var(--muted);padding:10px 14px;cursor:pointer;white-space:nowrap}
[role=tab][aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
[role=tab]:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
[role=tabpanel]{background:var(--surface);border:1px solid var(--line);border-top:0;border-radius:0 0 12px 12px;padding:20px}
.lens{color:var(--muted);margin:0;font-size:.9rem}
.call{font-size:1.15rem;margin:6px 0 12px}
.reasons li{margin-bottom:8px}
.watch{background:var(--warn);border:1px solid var(--warn-line);border-radius:10px;padding:10px 14px}.watch p{margin:4px 0 0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.card header{display:flex;justify-content:space-between;align-items:center;gap:8px}.card h3{margin:0;font-size:1.05rem}
.badge{font-size:.75rem;border-radius:999px;padding:2px 10px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.badge.changed{color:var(--accent);border-color:var(--accent)}
blockquote{margin:12px 0;padding-left:12px;border-left:3px solid var(--line);font-style:italic}
.rel{margin:8px 0}.rel p{margin:4px 0}.tag{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;font-weight:700}
.agree .tag{color:var(--agree)}.disagree .tag{color:var(--disagree)}
.final{margin:10px 0 0;padding-top:10px;border-top:1px solid var(--line)}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:.95rem}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.tablewrap{overflow-x:auto}
.rec{background:var(--surface);border:2px solid var(--accent);border-radius:12px;padding:16px 20px}
.rec p{margin:0 0 12px;font-size:1.05rem}
.copy{font:inherit;background:var(--accent);color:var(--bg);border:0;border-radius:8px;padding:8px 16px;cursor:pointer;font-weight:600}
.ai-note{color:var(--muted);font-size:.9rem;margin:-12px 0 20px}
.question{background:var(--warn);border:1px solid var(--warn-line);border-radius:12px;padding:14px 18px;font-size:1.05rem}
</style>
</head>
<body>
${topBar}
<main>
<h1>${esc(m.title || "Board meeting")}</h1>
<p class="meta">Board meeting · ${esc(m.date)} · ${experts.length} members · chaired</p>\n<p class="ai-note">These advisors are AI models on the c0mpute network, not real directors. Treat this as a structured second opinion, not professional advice.</p>

<div class="brief"><dl>
<dt>Decision</dt><dd>${esc(b.decision)}</dd>
<dt>Options</dt><dd>${list(b.options)}</dd>
<dt>Constraints</dt><dd>${list(b.constraints)}</dd>
${b.assumptions?.length ? `<dt>Assumptions the board worked from</dt><dd>${list(b.assumptions)}</dd>` : ""}
</dl></div>

<h2>Round 1: independent verdicts</h2>
<div role="tablist" aria-label="Expert verdicts">${verdictTabs}</div>
${verdictPanels}

<h2>Round 2: debate</h2>
<div class="cards">${debateCards}</div>

<h2>Round 3: minutes</h2>
<h3>The vote</h3>
<p>${esc(mn.majority)}</p>
<div class="tablewrap"><table><thead><tr><th>Member</th><th>Round 1 call</th><th>Final call</th><th>Changed</th></tr></thead><tbody>${voteRows}</tbody></table></div>
<h3>Where they clashed</h3>
<ul>${clashes}</ul>
<h3>Strongest dissent</h3>
<p><strong>${esc(nameOf(mn.dissent?.expert))}</strong>: ${esc(mn.dissent?.argument)}</p>
<h3>Chair's recommendation</h3>
<div class="rec"><p id="rec">${esc(mn.recommendation)}</p><button class="copy" id="copy" type="button">Copy recommendation</button></div>
<h3>The one question to answer before you decide</h3>
<p class="question">${esc(mn.question)}</p>
${voiceBlock}
${extra}
</main>
${footer}
<script>
const tabs=[...document.querySelectorAll('[role=tab]')];
function select(t){tabs.forEach(x=>{const on=x===t;x.setAttribute('aria-selected',on);x.tabIndex=on?0:-1;document.getElementById(x.getAttribute('aria-controls')).hidden=!on});t.focus()}
tabs.forEach((t,i)=>{t.addEventListener('click',()=>select(t));t.addEventListener('keydown',e=>{if(e.key==='ArrowRight')select(tabs[(i+1)%tabs.length]);if(e.key==='ArrowLeft')select(tabs[(i-1+tabs.length)%tabs.length])})});
document.getElementById('copy').addEventListener('click',async e=>{const text=document.getElementById('rec').textContent;const b=e.currentTarget;
try{await navigator.clipboard.writeText(text)}catch{const r=document.createRange();r.selectNodeContents(document.getElementById('rec'));const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');s.removeAllRanges()}
b.textContent='Copied';setTimeout(()=>b.textContent='Copy recommendation',1800)});
</script>
</body>
</html>
`;
return html;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , inPath, outPath = "report.html"] = process.argv;
  if (!inPath) {
    console.error("usage: render-report.js meeting.json [report.html]");
    process.exit(2);
  }
  writeFileSync(outPath, renderReport(JSON.parse(readFileSync(inPath, "utf8"))));
  console.log(`wrote ${outPath}`);
}
