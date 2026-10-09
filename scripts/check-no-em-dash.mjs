#!/usr/bin/env node
// Fails when panel text a user can read contains an em dash (kachat-audits KQS-022): anything in
// manager/public/index.html, and any non-comment line of the panel's JavaScript (its strings,
// toasts, job titles and error details). Code comments are left alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = '—';
const files = [
    ['manager/public/index.html', false],
    ['manager/public/app.js', true],
    ['manager/server.js', true],
    ...fs.readdirSync(path.join(root, 'manager/lib')).filter((f) => f.endsWith('.js')).map((f) => [`manager/lib/${f}`, true]),
];
const comment = /^\s*(\/\/|\*|\/\*)/;
let bad = 0;
for (const [rel, js] of files) {
    fs.readFileSync(path.join(root, rel), 'utf8')
        .split('\n')
        .forEach((line, i) => {
            if (!line.includes(DASH)) return;
            if (js && (comment.test(line) || line.indexOf('//') !== -1 && line.indexOf('//') < line.indexOf(DASH))) return;
            if (!js && /^\s*(<!--|-->)/.test(line)) return;
            console.error(`${rel}:${i + 1}: em dash in user-facing text: ${line.trim().slice(0, 120)}`);
            bad += 1;
        });
}
if (bad) {
    console.error(`\n${bad} em dash(es). Use a comma, colon, period or parentheses instead.`);
    process.exit(1);
}
console.log('No em dashes in panel text.');
