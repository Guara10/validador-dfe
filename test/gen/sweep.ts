// Varredura de falsos positivos: npx vite-node test/gen/sweep.ts <n>
import { genNote, toXml, toTx2 } from './nota';
import { analyze } from '../../src/core/analyze';
import { nfeDict, nfeSchemas } from '../../src/core/engine-data';
import { parseXml } from '../../src/core/xml/parse';
import { formatXml } from '../../src/core/xml/format';
import { nodeRunner } from '../node-runner';
const eng = { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas, now: () => new Date('2026-10-28T12:00:00-03:00') };
const canon = (x: string) => formatXml(parseXml(x), { fromValues: true }).text;
const n = +(process.argv[2] ?? 50);
const t0 = Date.now();
const bad: string[] = [];
const count: Record<string, number> = {};
for (let seed = 1; seed <= n; seed++) {
  const g = genNote(seed);
  g.items.forEach((i) => (count[i.cst] = (count[i.cst] ?? 0) + 1));
  const xml = toXml(g), tx2 = toTx2(g, { prefixPag: seed % 2 === 0, crlf: seed % 3 === 0 });
  for (const [k, t] of [['xml', xml], ['xml1', toXml(g, { oneLine: true })], ['tx2', tx2]] as const) {
    const [a] = await analyze(t, eng);
    const fs = a.findings.filter((f) => f.sev !== 'info');
    if (fs.length || !a.schemaOk) bad.push(`seed ${seed} ${k}: ` + fs.map((f) => `[${f.sev}${f.code ? ' ' + f.code : ''}] L${f.line} ${f.tx2Field ?? ''} ${f.title} | ${f.message.slice(0, 120)} | enc=${f.found}`).join('\n    '));
    if (k === 'tx2' && canon(a.generatedXml!) !== canon(xml)) {
      const A = canon(a.generatedXml!).split('\n'), B = canon(xml).split('\n');
      const i = A.findIndex((l, j) => l !== B[j]);
      bad.push(`seed ${seed} tx2->xml diferente na linha ${i + 1}: montado "${A[i]?.trim()}" x esperado "${B[i]?.trim()}"`);
    }
  }
}
console.log(`${n} notas, ${((Date.now() - t0) / 1000).toFixed(1)}s, CSTs:`, JSON.stringify(count));
console.log(bad.length ? bad.slice(0, 40).join('\n') : 'nenhum falso positivo');
console.log('total problemas:', bad.length);
