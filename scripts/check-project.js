'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const fail = message => { console.error(`CHECK FAILED: ${message}`); process.exitCode = 1; };

const html = read('public/index.html');
const app = read('public/app.js');
const css = read('public/style.css');
const worker = read('src/worker.js');
const config = JSON.parse(read('wrangler.jsonc'));
const dictionary = JSON.parse(read('public/data/words.json'));

const idList = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
const idSet = new Set(idList);
const duplicates = [...new Set(idList.filter((id, index) => idList.indexOf(id) !== index))];
if (duplicates.length) fail(`Duplicate HTML IDs: ${duplicates.join(', ')}`);

const referencedIds = [...app.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
const missingIds = [...new Set(referencedIds.filter(id => !idSet.has(id)))];
if (missingIds.length) fail(`JavaScript references missing HTML IDs: ${missingIds.join(', ')}`);

if (!Object.keys(dictionary).length) fail('Dictionary is empty.');
if (!Array.isArray(dictionary['なたでここ']) || !dictionary['なたでここ'].includes('ナタデココ')) {
  fail('Dictionary sample entry なたでここ → ナタデココ is missing.');
}
if (!html.includes('id="revealed-min"') || !html.includes('id="revealed-max"')) fail('Public-character range slider is missing.');
if (!app.includes('wipe.animate(') || !app.includes('el.animate(')) fail('Territory and question animations are not driven by the Web Animations API.');
if (!html.includes('class="time-settings-row"')) fail('Time settings are not grouped into one horizontal row.');
if (config.name !== 'egoism' || config.main !== 'src/worker.js') fail('Cloudflare Worker config does not match this project.');
if (!worker.includes('class GameRoom')) fail('Durable Object class GameRoom was not found.');
if (!worker.includes('ROOMS_BINDING_MISSING') || !worker.includes('room-api-v5')) fail('Room API diagnostics are missing.');
if (!/function\s+clamp\s*\(/.test(worker)) fail('Worker clamp helper is missing.');
if (!css.includes('.territory-wipe') || !css.includes('!important')) fail('Territory animation overlay styles are missing.');
if (html.includes('board-foot') || html.includes('pattern-hint-desktop')) fail('A removed legacy board element is still present.');

if (process.exitCode) process.exit(process.exitCode);
console.log(`Project checks passed: ${idSet.size} HTML IDs, ${Object.keys(dictionary).length.toLocaleString()} dictionary readings, Cloudflare config, and territory animations.`);
