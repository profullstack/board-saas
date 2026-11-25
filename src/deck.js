// The meeting as a slide deck (Anthony 2026-11-25: "add a professional branded powerpoint ppt file
// i can download too with summaries, arguments, and final decision back up with data if possible.
// it needs to be maybe a 5 minute presentation").
//
// Eight slides with speaker notes, about 35-40 seconds each: the decision, the recommendation with
// the vote in numbers, how the vote moved (a native chart, round 1 against the final round), the five
// verdicts, the debate, the strongest dissent, the numbers the board argued from, and what happens
// next. Made on request from the stored meeting, so it is always current and never stored.
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';

const INK = '141413';
const PAPER = 'FFFFFF';
const SOFT = 'F3F2EE';
const LINE = 'E3E1DB';
const MUTED = '5F5E5A';
const ACCENT = '2F5BD3';
const ALERT = 'B3412E';
const HEAD = 'Cambria';
const BODY = 'Calibri';

/** Each advisor's color, the same as their name in the meeting video. */
const ROLE = {
  cfo: { color: '2F9E5B', short: 'CFO' },
  growth: { color: 'D9822B', short: 'Growth' },
  operator: { color: '2B7FD9', short: 'Operator' },
  'founder-time': { color: '9B4FC9', short: 'Founder-Time' },
  contrarian: { color: 'C8463D', short: 'Contrarian' },
};
const roleOf = (id) => ROLE[id] || { color: ACCENT, short: String(id || '').replace(/^the /i, '') };

/** Shorten on a word boundary, ending with an ellipsis when cut. */
export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).replace(/[\s,;:]+\S*$/, '')}...`;
}

/** The option's own letter ("A) Freemium ..." -> "A"), or null when the brief gave it none. */
function optionLabel(options, i) {
  const m = /^\s*([A-Z])[).:-]/.exec(String(options?.[i] ?? ''));
  return m ? m[1] : null;
}

/** How to name an option in a sentence: "option A", or its own words when the brief gave no letter ("a combination of the options"). */
export function optionPhrase(options, i) {
  const letter = optionLabel(options, i);
  if (letter) return `option ${letter}`;
  const text = optionName(options?.[i]);
  if (/combination/i.test(text)) return 'a combination of the options';
  return clip(text.charAt(0).toLowerCase() + text.slice(1), 50);
}
const optionName = (o) => String(o ?? '').replace(/^\s*[A-Z][).:-]\s*/, '');

/**
 * Figures the board argued from: sentences in the verdicts, clashes and dissent that carry a money
 * amount or a percentage, with the figure pulled out for a stat callout. At most `max`, no repeats.
 */
export function numbersBehind(meeting, max = 4) {
  const lines = [];
  const add = (text, who) => {
    for (const sentence of String(text ?? '').split(/(?<=[.;])\s+/)) {
      const m = /(\$\s?\d[\d,.]*\s?(?:[kKmM](?![a-z])|\/(?:mo|month|yr|year|day|h))?|\d[\d,.]*\s?%)/.exec(sentence);
      if (m && sentence.length > 25 && !/^\$?0(?![\d.,])/.test(m[1].replace(/\s+/g, ''))) lines.push({ figure: m[1].replace(/\s+/g, ''), text: sentence.trim(), who });
    }
  };
  for (const c of meeting.minutes?.clashes ?? []) add(c.crux, c.topic);
  for (const v of meeting.verdicts ?? []) for (const r of v.reasons ?? []) add(r, v.expert);
  add(meeting.minutes?.dissent?.argument, meeting.minutes?.dissent?.expert);
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    if (seen.has(l.figure)) continue;
    seen.add(l.figure);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

/** Round-1 and final option counts for the chart. */
export function voteCounts(meeting) {
  const options = meeting.brief?.options ?? [];
  const r1 = options.map(() => 0);
  const fin = options.map(() => 0);
  const idx = (x) => (Number.isInteger(x) ? x - 1 : -1);
  for (const v of meeting.verdicts ?? []) if (idx(v.option) >= 0 && idx(v.option) < options.length) r1[idx(v.option)]++;
  for (const d of meeting.debate ?? []) if (idx(d.option) >= 0 && idx(d.option) < options.length) fin[idx(d.option)]++;
  return { options, r1, fin, has: r1.some(Boolean) || fin.some(Boolean) };
}


/** Trim to about `words` words, ending on a sentence where possible (for the spoken script). */
function words(text, max) {
  const w = String(text ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (w.length <= max) return w.join(' ');
  const cut = w.slice(0, max).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > cut.length * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/[,;:]$/, '')}.`;
}

/**
 * What the Chair says over each slide, in slide order: the speaker notes of the deck and the
 * narration of the slide-show video (Anthony 2026-11-25: "have the chairman narrate ... talking
 * through our slides"). About 550 words in all, four to five minutes at a speaking pace.
 */
export function deckNarration(meeting) {
  const m = meeting;
  const experts = Object.fromEntries((m.experts ?? []).map((e) => [e.id, e]));
  const nameOf = (id) => experts[id]?.name || roleOf(id).short;
  const decision = m.brief?.decision || m.title || 'the decision in front of us';
  const changed = (m.minutes?.vote ?? []).filter((v) => v.changed).length;
  const out = [];
  out.push(words(`Welcome. I'm the chair of your AI board. Today's decision: ${decision} Five advisors looked at it, each through their own lens: the CFO, Growth, the Operator, Founder-Time and the Contrarian. I'll give you our recommendation first, then how we got there.`, 75));
  out.push(words(`Here is where we landed. ${m.minutes?.recommendation ?? ''}`, 95));
  out.push(words(`Each advisor voted twice: once on their own, then again after reading the others. ${changed ? `${changed} changed position in the debate.` : 'Nobody changed position in the debate.'} ${m.minutes?.majority ?? ''}`, 80));
  out.push(words(`In a sentence each. ${(m.verdicts ?? []).slice(0, 5).map((v) => `${nameOf(v.expert)}: ${words(v.call, 24)}`).join(' ')}`, 125));
  const clashes = (m.minutes?.clashes ?? []).slice(0, 3);
  out.push(words(clashes.length ? `Where we disagreed. ${clashes.map((c) => `On ${String(c.topic || '').toLowerCase()}: ${words(c.sides, 30)}`).join(' ')}` : 'We did not split on any point.', 95));
  out.push(words(`Before you decide, here is the strongest case against the majority, from ${nameOf(m.minutes?.dissent?.expert)}. ${m.minutes?.dissent?.argument ?? ''}`, 85));
  const nums = numbersBehind(m);
  if (nums.length) out.push(words(`The numbers behind it. ${nums.map((n) => n.text).join(' ')}`, 85));
  out.push(words(`One question for you to answer next. ${m.minutes?.question ?? ''} Thank you. The full minutes, the debate and the recording are on the meeting page.`, 75));
  return out;
}

/** Build the deck; resolves to a Node Buffer of the .pptx. */
export async function meetingDeck(meeting, { url = null } = {}) {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pres.author = 'Board as a Service';
  pres.company = 'Profullstack';
  pres.title = clip(meeting.title || meeting.brief?.decision || 'Board meeting', 120);
  pres.theme = { headFontFace: HEAD, bodyFontFace: BODY };

  const footer = (dark) => [
    { text: { text: 'Board as a Service', options: { x: 0.6, y: 6.95, w: 6, h: 0.3, fontFace: BODY, fontSize: 10, color: dark ? 'A3A29C' : MUTED, margin: 0 } } },
  ];
  pres.defineSlideMaster({
    title: 'CONTENT',
    background: { color: PAPER },
    objects: [
      ...footer(false),
      { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 0.45, w: 12.1, h: 0.85, fontFace: HEAD, fontSize: 36, bold: true, color: INK, margin: 0, valign: 'top', align: 'left' }, text: '' } },
    ],
    slideNumber: { x: 12.2, y: 6.95, w: 0.6, h: 0.3, fontFace: BODY, fontSize: 10, color: MUTED, align: 'right' },
  });
  pres.defineSlideMaster({ title: 'DARK', background: { color: INK }, objects: footer(true) });

  const m = meeting;
  const experts = Object.fromEntries((m.experts ?? []).map((e) => [e.id, e]));
  const nameOf = (id) => experts[id]?.name || roleOf(id).short;
  const decision = m.brief?.decision || m.title || 'The decision';
  const votes = m.minutes?.vote ?? [];
  const changed = votes.filter((v) => v.changed).length;
  const counts = voteCounts(m);
  const lead = counts.fin.some(Boolean) ? counts.fin : counts.r1;
  const top = lead.length ? lead.indexOf(Math.max(...lead)) : -1;
  const backing = top >= 0 ? lead[top] : null;
  const seats = (m.verdicts ?? []).length || 5;
  const narration = deckNarration(m);
  let said = 0;
  const notes = (slide) => slide.addNotes(narration[said++] ?? '');
  const text = (slide, t, o) => slide.addText(t, { isTextBox: true, fontFace: BODY, color: INK, margin: 0, valign: 'top', ...o });

  // 1. Title
  let s = pres.addSlide({ masterName: 'DARK' });
  text(s, 'BOARD MEETING', { x: 0.8, y: 1.3, w: 11.5, h: 0.4, fontSize: 14, bold: true, color: '8AA8FF', charSpacing: 4 });
  text(s, clip(decision, 150), { x: 0.8, y: 1.85, w: 11.5, h: 2.6, fontFace: HEAD, fontSize: 40, bold: true, color: 'FFFFFF' });
  text(s, `${m.date || ''}  ·  ${(m.experts ?? []).map((e) => roleOf(e.id).short).join(', ') || 'Five AI advisors'}`, { x: 0.8, y: 4.75, w: 11.5, h: 0.4, fontSize: 16, color: 'D6D4CD' });
  (m.experts ?? []).slice(0, 5).forEach((e, i) => {
    s.addShape(pres.shapes.OVAL, { x: 0.8 + i * 0.62, y: 5.45, w: 0.42, h: 0.42, fill: { color: roleOf(e.id).color }, line: { color: roleOf(e.id).color } });
  });
  notes(s);

  // 2. Recommendation
  s = pres.addSlide({ masterName: 'CONTENT' });
  s.addText('The recommendation', { placeholder: 'title' });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 1.55, w: 7.7, h: 4.9, fill: { color: SOFT }, line: { color: SOFT }, rectRadius: 0.12 });
  text(s, clip(m.minutes?.recommendation, 900), { x: 0.95, y: 1.85, w: 7.0, h: 4.3, fontSize: 18, color: INK, paraSpaceAfter: 6, fit: 'shrink' });
  const stats = [
    backing != null ? [`${backing}/${seats}`, top >= 0 ? `back ${optionPhrase(counts.options, top)} in the final round` : 'in the majority'] : null,
    [`${changed}`, changed === 1 ? 'advisor changed their mind in debate' : 'advisors changed their minds in debate'],
    [`${(m.minutes?.clashes ?? []).length}`, 'open disagreements, named on slide 5'],
  ].filter(Boolean);
  stats.forEach(([big, label], i) => {
    const y = 1.55 + i * 1.68;
    text(s, big, { x: 8.75, y, w: 4.0, h: 0.95, fontFace: HEAD, fontSize: 54, bold: true, color: ACCENT });
    text(s, label, { x: 8.75, y: y + 0.95, w: 4.0, h: 0.6, fontSize: 14, color: MUTED });
  });
  notes(s);

  // 3. How the vote moved
  s = pres.addSlide({ masterName: 'CONTENT' });
  s.addText('How the board voted', { placeholder: 'title' });
  if (counts.has) {
    const labels = counts.options.map((o, i) => (optionLabel(counts.options, i) ? `${optionLabel(counts.options, i)}  ${clip(optionName(o), 28)}` : clip(optionName(o), 32)));
    s.addChart(
      pres.charts.BAR,
      [
        { name: 'Round 1', labels, values: counts.r1 },
        { name: 'Final round', labels, values: counts.fin },
      ],
      {
        x: 0.6, y: 1.5, w: 7.9, h: 5.1, barDir: 'bar', barGrouping: 'clustered', chartColors: ['A9BEF2', ACCENT],
        showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: INK, dataLabelFontSize: 12, dataLabelFontFace: BODY,
        catAxisLabelColor: INK, catAxisLabelFontSize: 12, catAxisLabelFontFace: BODY, catAxisOrientation: 'maxMin',
        valAxisHidden: true, valAxisMinVal: 0, valAxisMaxVal: seats, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
        showLegend: true, legendPos: 't', legendFontSize: 12, legendFontFace: BODY, legendColor: INK,
        showTitle: false,
      },
    );
  }
  text(s, clip(m.minutes?.majority, 300), { x: counts.has ? 8.9 : 0.6, y: 1.6, w: counts.has ? 3.85 : 12.1, h: 4.9, fontSize: 16, color: INK, fit: 'shrink' });
  notes(s);

  // 4. The five verdicts
  s = pres.addSlide({ masterName: 'CONTENT' });
  s.addText('Five advisors, five lenses', { placeholder: 'title' });
  const vs = (m.verdicts ?? []).slice(0, 5);
  const cw = (12.1 - (vs.length - 1) * 0.25) / Math.max(1, vs.length);
  vs.forEach((v, i) => {
    const x = 0.6 + i * (cw + 0.25);
    const r = roleOf(v.expert);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.55, w: cw, h: 5.0, fill: { color: SOFT }, line: { color: LINE }, rectRadius: 0.1 });
    s.addShape(pres.shapes.OVAL, { x: x + 0.25, y: 1.8, w: 0.5, h: 0.5, fill: { color: r.color }, line: { color: r.color } });
    text(s, r.short, { x: x + 0.25, y: 2.45, w: cw - 0.5, h: 0.75, fontFace: HEAD, fontSize: 17, bold: true, color: INK, fit: 'shrink' });
    text(s, clip(experts[v.expert]?.lens, 60), { x: x + 0.25, y: 3.2, w: cw - 0.5, h: 0.55, fontSize: 11, color: MUTED });
    text(s, clip(v.call, 220), { x: x + 0.25, y: 3.8, w: cw - 0.5, h: 2.6, fontSize: 14, color: INK, fit: 'shrink' });
  });
  notes(s);

  // 5. The debate
  s = pres.addSlide({ masterName: 'CONTENT' });
  s.addText('Where they disagreed', { placeholder: 'title' });
  const clashes = (m.minutes?.clashes ?? []).slice(0, 3);
  clashes.forEach((c, i) => {
    const y = 1.55 + i * 1.72;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y, w: 12.1, h: 1.52, fill: { color: i % 2 ? PAPER : SOFT }, line: { color: LINE }, rectRadius: 0.08 });
    text(s, clip(c.topic, 60), { x: 0.9, y: y + 0.2, w: 2.6, h: 1.15, fontFace: HEAD, fontSize: 17, bold: true, color: ACCENT });
    text(s, clip(c.sides, 190), { x: 3.6, y: y + 0.18, w: 8.8, h: 0.7, fontSize: 14, color: INK, fit: 'shrink' });
    text(s, `The crux: ${clip(c.crux, 160)}`, { x: 3.6, y: y + 0.88, w: 8.8, h: 0.55, fontSize: 12, italic: true, color: MUTED, fit: 'shrink' });
  });
  if (!clashes.length) text(s, 'The board did not split on any point.', { x: 0.6, y: 1.6, w: 12.1, h: 0.6, fontSize: 18 });
  notes(s);

  // 6. Strongest dissent
  s = pres.addSlide({ masterName: 'CONTENT' });
  s.addText('The strongest dissent', { placeholder: 'title' });
  const dissent = m.minutes?.dissent;
  const dr = roleOf(dissent?.expert);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 1.55, w: 12.1, h: 4.95, fill: { color: SOFT }, line: { color: SOFT }, rectRadius: 0.12 });
  text(s, '“', { x: 0.95, y: 1.6, w: 1.2, h: 1.2, fontFace: HEAD, fontSize: 96, bold: true, color: ALERT });
  text(s, clip(dissent?.argument, 700), { x: 1.95, y: 2.0, w: 10.3, h: 3.4, fontFace: HEAD, fontSize: 22, italic: true, color: INK, fit: 'shrink' });
  s.addShape(pres.shapes.OVAL, { x: 1.95, y: 5.65, w: 0.42, h: 0.42, fill: { color: dr.color }, line: { color: dr.color } });
  text(s, nameOf(dissent?.expert), { x: 2.55, y: 5.68, w: 8, h: 0.4, fontSize: 16, bold: true, color: INK });
  notes(s);

  // 7. The numbers
  const nums = numbersBehind(m);
  if (nums.length) {
    s = pres.addSlide({ masterName: 'CONTENT' });
    s.addText('The numbers behind it', { placeholder: 'title' });
    const nw = (12.1 - (nums.length - 1) * 0.3) / nums.length;
    nums.forEach((n, i) => {
      const x = 0.6 + i * (nw + 0.3);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.55, w: nw, h: 4.95, fill: { color: SOFT }, line: { color: LINE }, rectRadius: 0.1 });
      text(s, clip(n.figure, 12), { x: x + 0.3, y: 1.85, w: nw - 0.6, h: 1.1, fontFace: HEAD, fontSize: 44, bold: true, color: ACCENT, fit: 'shrink' });
      text(s, clip(n.text, 210), { x: x + 0.3, y: 3.05, w: nw - 0.6, h: 2.9, fontSize: 14, color: INK, fit: 'shrink' });
      text(s, roleOf(n.who).short === n.who ? clip(n.who, 30) : roleOf(n.who).short, { x: x + 0.3, y: 6.0, w: nw - 0.6, h: 0.35, fontSize: 11, color: MUTED });
    });
    notes(s);
  }

  // 8. Next step
  s = pres.addSlide({ masterName: 'DARK' });
  text(s, 'THE QUESTION TO ANSWER NEXT', { x: 0.8, y: 1.3, w: 11.5, h: 0.4, fontSize: 14, bold: true, color: '8AA8FF', charSpacing: 4 });
  text(s, clip(m.minutes?.question, 260), { x: 0.8, y: 1.85, w: 11.5, h: 2.9, fontFace: HEAD, fontSize: 32, bold: true, color: 'FFFFFF', fit: 'shrink' });
  text(s, `${url ? `Full minutes, debate and recording: ${url}\n` : ''}The advisors are AI models, not real directors. This is not legal, tax or investment advice.`, { x: 0.8, y: 5.1, w: 11.5, h: 1.2, fontSize: 14, color: 'D6D4CD' });
  notes(s);

  // pptxgenjs writes folder entries into the ZIP; Office opens such a file locally but cloud
  // storage (OneDrive, Google Drive) can refuse it. Repack without them.
  const src = await JSZip.loadAsync(await pres.write({ outputType: 'nodebuffer' }));
  const out = new JSZip();
  // [Content_Types].xml first, as Office writes it; then every file, no folder entries.
  const names = Object.keys(src.files).filter((n) => !src.files[n].dir);
  names.sort((a, b) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0));
  for (const n of names) out.file(n, await src.files[n].async('nodebuffer'), { createFolders: false });
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
