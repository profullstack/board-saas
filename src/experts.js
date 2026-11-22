// The board: five experts and a chair. Their personas are the boardroom plugin's skill
// texts (profullstack/boardroom skills/<id>/SKILL.md), copied verbatim into ./experts and
// used as system prompts with the frontmatter removed.
import { readFileSync } from 'node:fs';

export const EXPERTS = [
  { id: 'cfo', name: 'The CFO', lens: 'Cash, runway, unit economics and payback' },
  { id: 'growth', name: 'The Growth Marketer', lens: 'Audience, distribution and revenue growth' },
  { id: 'operator', name: 'The Operator', lens: 'Systems, delegation readiness and execution' },
  { id: 'founder-time', name: 'The Founder-Time Strategist', lens: 'Founder hours and highest-value work' },
  { id: 'contrarian', name: 'The Contrarian Investor', lens: 'Inversion, reversibility and opportunity cost' },
];

export const EXPERT_IDS = EXPERTS.map((e) => e.id);

export function stripFrontmatter(text) {
  return String(text).replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
}

const cache = new Map();
/** The persona text for an expert id or 'chair'. */
export function persona(id) {
  if (!cache.has(id)) {
    const url = new URL(`./experts/${id}.md`, import.meta.url);
    cache.set(id, stripFrontmatter(readFileSync(url, 'utf8')));
  }
  return cache.get(id);
}

export const nameOf = (id) => EXPERTS.find((e) => e.id === id)?.name ?? id;
