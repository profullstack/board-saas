#!/usr/bin/env node
import { main } from '../src/cli.js';

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    process.stderr.write(`board-saas: ${e?.message ?? e}\n`);
    process.exit(1);
  },
);
