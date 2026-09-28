#!/usr/bin/env bash
# Every t() key the desktop layout uses must EXIST in en.json.
#
# This app's translate() returns THE KEY ITSELF when a key is missing -- see
# utils/translate.test.js line 21. It does not accept a default string. So
# t('scan.colCard', 'Card') does not render "Card"; it renders the literal
# text "scan.colCard" on screen.
#
# That is a silent, ugly failure that no build or lint catches.
cd /home/hermes/repos/bindarr

node -e "
const fs = require('fs');
const en = JSON.parse(fs.readFileSync('frontend/src/locales/en.json', 'utf8'));
const src = fs.readFileSync('frontend/src/components/DesktopScanLayout.jsx', 'utf8');

const keys = [...src.matchAll(/\bt\(\s*'([^']+)'/g)].map(m => m[1]);
const missing = [...new Set(keys)].filter(k => !(k in en));

console.log('t() keys used :', new Set(keys).size);
console.log('missing       :', missing.length);
for (const k of missing) console.log('  ' + k);
process.exit(missing.length ? 1 : 0);
"
