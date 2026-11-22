// Footers, in the fleet order for a Moshpit site: our own site footer, the Profullstack
// webring row (@profullstack/footer, server-rendered because the ring verifier never runs
// script), then the pit.world global footer last (pit.world/snippets/footer.html).
import { footerHtml, footerHtmlSync } from '@profullstack/footer';

export const SITE = 'https://board.saas.pit.world/';
const PIT_SNIPPET = 'https://pit.world/snippets/footer.html?site=board.saas.pit.world';

const RING_OPTIONS = {
  site: SITE,
  links: [
    { label: 'API', href: 'https://board.saas.pit.world/api/v1' },
    { label: 'CLI', href: 'https://www.npmjs.com/package/@profullstack/board-saas' },
    { label: 'MCP', href: 'https://board.saas.pit.world/api/v1' },
  ],
  since: 2026,
  tagline: 'AI advisors, not real directors',
};

export function siteFooter() {
  return `<div class="site-footer"><p><strong>Board as a Service</strong> runs five AI advisors and a chair on open models on the <a href="https://c0mpute.com">c0mpute</a> peer network. They are software, not real directors, and nothing here is legal, tax or investment advice. Built from the open-source <a href="https://github.com/profullstack/boardroom">boardroom</a> plugin.</p></div>`;
}

let ring = footerHtmlSync({ ...RING_OPTIONS, version: 'bundled' });
let pit = '';

export async function refreshFooters(fetchImpl = fetch) {
  try {
    const next = await footerHtml(RING_OPTIONS);
    if (typeof next === 'string' && next.includes('/ring/profullstack')) ring = next;
  } catch {
    /* keep the last good copy */
  }
  try {
    const r = await fetchImpl(PIT_SNIPPET, { signal: AbortSignal.timeout(4000) });
    const html = r.ok ? (await r.text()).trim() : '';
    if (html.includes('data-pit-footer') && html.length < 64_000) pit = html;
  } catch {
    /* keep the last good copy */
  }
  return allFooters();
}

export function startFooterRefresh(everyMs = 30 * 60_000) {
  refreshFooters();
  const t = setInterval(refreshFooters, everyMs);
  t.unref?.();
}

export function allFooters() {
  return `${siteFooter()}\n${ring}\n${pit}`;
}
