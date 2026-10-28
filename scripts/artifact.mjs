// Gera dist/artifact.html: o mesmo app sem o esqueleto <html>/<head>/<body>,
// no formato que a hospedagem de artefatos do Claude espera.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('dist/index.html', 'utf8');
const out = html
  .replace(/<!doctype html>/i, '')
  .replace(/<html[^>]*>|<\/html>|<head>|<\/head>|<body>|<\/body>/gi, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .trim();
writeFileSync('dist/artifact.html', out);
console.log('dist/artifact.html', (out.length / 1024).toFixed(0), 'KB');
