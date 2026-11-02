// Renders k6/catalog.js into the example-query section of README.md, between the markers
//   <!-- queries:start --> ... <!-- queries:end -->
//
//   node k6/render-readme.mjs           # rewrite the section
//   node k6/render-readme.mjs --check   # exit 1 if README.md is out of date (like schema:check)
//
// The same catalog drives k6/api-examples.js, so every query printed in the README is one the k6
// script runs and asserts on.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalog, SAMPLE_CTX } from './catalog.js';

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const START = '<!-- queries:start -->';
const END = '<!-- queries:end -->';

function renderQuery(entry) {
  const out = [`**${entry.id}. ${entry.title}**`, ''];
  if (entry.note) out.push(entry.note, '');
  entry.steps.forEach((step, i) => {
    if (entry.steps.length > 1) out.push(i === 0 ? 'Request 1:' : `Request ${i + 1}:`, '');
    out.push('```graphql', step.query(SAMPLE_CTX), '```', '');
    const vars = step.sampleVars ? step.sampleVars(SAMPLE_CTX) : step.vars ? step.vars(SAMPLE_CTX, undefined) : undefined;
    if (vars !== undefined) out.push('Variables:', '', '```json', JSON.stringify(vars), '```', '');
    if (step.operationName) out.push(`Send \`"operationName": "${step.operationName}"\`.`, '');
    if (step.walk) out.push('Repeat while `pageInfo.hasNextPage` is true, sending `endCursor` back as `after`.', '');
  });
  return out.join('\n');
}

export function render() {
  const groups = [];
  for (const entry of catalog) {
    let g = groups.find((x) => x.name === entry.group);
    if (!g) groups.push((g = { name: entry.group, entries: [] }));
    g.entries.push(entry);
  }
  const body = groups.map((g) => {
    const first = g.entries[0].id;
    const last = g.entries[g.entries.length - 1].id;
    return [
      `<details>`,
      `<summary><b>${g.name}</b> (${first}-${last})</summary>`,
      '',
      g.entries.map(renderQuery).join('\n'),
      `</details>`,
      '',
    ].join('\n');
  });
  return [
    START,
    `<!-- Generated from k6/catalog.js by \`npm run docs:queries\`. Do not edit by hand. -->`,
    '',
    `${catalog.length} queries, grouped by task. Values (BRYAN, RICHMOND HILL, ids) come from the dev data set.`,
    '',
    body.join('\n'),
    END,
  ].join('\n');
}

const readme = readFileSync(README, 'utf8');
const count = (marker) => readme.split(marker).length - 1;
const a = readme.indexOf(START);
const b = readme.indexOf(END);
if (count(START) !== 1 || count(END) !== 1 || b < a) {
  console.error(`README.md needs exactly one ${START} followed by exactly one ${END} (found ${count(START)} and ${count(END)})`);
  process.exit(2);
}
const next = readme.slice(0, a) + render() + readme.slice(b + END.length);
if (process.argv.includes('--check')) {
  if (next !== readme) {
    console.error('README.md example queries are out of date: run `npm run docs:queries`');
    process.exit(1);
  }
  console.log('README.md example queries are up to date');
} else {
  writeFileSync(README, next);
  console.log(`README.md updated (${catalog.length} queries)`);
}
