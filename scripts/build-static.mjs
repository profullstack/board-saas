#!/usr/bin/env node
// Build the public site into ./site with the footers baked in (the ring verifier reads
// HTML and never runs script). ./site is what goes to c0mpute hosting and what the server
// falls back to when the c0mpute gateway does not answer.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { refreshFooters } from '../src/footers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}site`;
mkdirSync(out, { recursive: true });
const footers = await refreshFooters();
if (!footers.includes('/ring/profullstack')) throw new Error('the ring footer did not render');
if (!footers.includes('data-pit-footer')) console.warn('warning: the pit.world footer did not load; building without it');
const html = readFileSync(`${root}public/index.html`, 'utf8').replace('<!--FOOTERS-->', footers);
writeFileSync(`${out}/index.html`, html);
for (const f of ['style.css', 'app.js']) copyFileSync(`${root}public/${f}`, `${out}/${f}`);
console.log(`built ${out} (${html.length} bytes of HTML)`);
