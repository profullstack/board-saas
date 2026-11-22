// Transactional email through Resend. The fleet's pit.world key can only send from
// pit.world, so the address stays hello@pit.world and the name says who is writing.
// Every message carries the network cross-promo block (@profullstack/cross-promo).
import { promoBlock } from '@profullstack/cross-promo';

const FROM = 'Board as a Service <hello@pit.world>';
const SITE = 'board.saas.pit.world';

export function createMailer(env = process.env, fetchImpl = fetch) {
  const key = env.RESEND_API_KEY;
  if (!key) return null;
  return async function send({ to, subject, text, html }) {
    let promo = { text: '', html: '' };
    try {
      promo = await promoBlock({ site: SITE, audience: ['makers', 'developers'], seed: to });
    } catch {
      /* a mail never waits on the catalog */
    }
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject,
        text: promo.text ? `${text}\n\n${promo.text}` : text,
        html: `${html}${promo.html ?? ''}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const wrapHtml = (body) =>
  `<div style="font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1d1b;max-width:560px">${body}</div>`;

export function codeEmail(code) {
  return {
    subject: `Your Board as a Service code: ${code}`,
    text: `Your sign-in code is ${code}\n\nIt works for 15 minutes. If you did not ask for it, ignore this email.\n\nhttps://${SITE}`,
    html: wrapHtml(
      `<p>Your sign-in code:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0">${esc(code)}</p><p>It works for 15 minutes. If you did not ask for it, ignore this email.</p><p><a href="https://${SITE}">${SITE}</a></p>`,
    ),
  };
}

export function voiceFailedEmail(reason, url) {
  return {
    subject: 'Your board call could not start',
    text: `The live PairUX call for your board meeting could not start: ${reason}\n\nNothing extra was charged. The board still meets as text, and the minutes will be at ${url} (we email you when they are ready). You can start a new voice meeting at any time.\n\nhttps://${SITE}`,
    html: wrapHtml(
      `<p>The live PairUX call for your board meeting could not start:</p><p><em>${esc(reason)}</em></p><p>Nothing extra was charged. The board still meets as text, and the minutes will be at <a href="${esc(url)}">${esc(url)}</a> (we email you when they are ready). You can start a new voice meeting at any time.</p>`,
    ),
  };
}

export function meetingDoneEmail(meeting, url) {
  const m = meeting;
  return {
    subject: `Board minutes: ${m.title}`,
    text: `Your board met on "${m.brief.decision}".\n\nMajority: ${m.minutes.majority}\n\nChair's recommendation: ${m.minutes.recommendation}\n\nThe one question to answer: ${m.minutes.question}\n${m.qa?.length ? `\nFounder Q&A: ${m.qa.length} question(s) answered on the call (in the report).\n` : ''}\nFull report (private: sign in to open it, or share it from the page): ${url}\n\nThe advisors are AI models, not real directors.`,
    html: wrapHtml(
      `<p>Your board met on <strong>${esc(m.brief.decision)}</strong>.</p><p><strong>Majority:</strong> ${esc(m.minutes.majority)}</p><p><strong>Chair's recommendation:</strong> ${esc(m.minutes.recommendation)}</p><p><strong>The one question to answer:</strong> ${esc(m.minutes.question)}</p>${m.qa?.length ? `<p><strong>Founder Q&amp;A:</strong> ${m.qa.length} question(s) answered on the call, in the report.</p>` : ''}<p><a href="${esc(url)}">Read the full report</a> (private: open it signed in, or share it from the page)</p><p style="color:#5f5e5a;font-size:14px">The advisors are AI models, not real directors.</p>`,
    ),
  };
}
