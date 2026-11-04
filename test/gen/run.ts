// Diagnóstico rápido do gerador: npx vite-node test/gen/run.ts <seed>
import { genNote, toXml, toTx2 } from './nota';
import { analyze } from '../../src/core/analyze';
import { nfeDict, nfeSchemas } from '../../src/core/engine-data';
import { nodeRunner } from '../node-runner';
const eng = { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas, now: () => new Date('2026-10-28T12:00:00-03:00') };
const seed = +(process.argv[2] ?? 1);
const g = genNote(seed);
for (const [k, t] of [['xml', toXml(g)], ['tx2', toTx2(g)]] as const) {
  const [a] = await analyze(t, eng);
  console.log(`== seed ${seed} ${k} crt=${g.crt} ibs=${g.ibs} csts=${g.items.map((i) => i.cst).join(',')} schemaOk=${a.schemaOk}`);
  for (const f of a.findings.filter((f) => f.sev !== 'info')) console.log(`  [${f.sev}] L${f.line} ${f.tx2Field ?? ''} ${f.title} :: ${f.message.slice(0, 160)} ${f.found ? '| enc ' + f.found : ''}`);
  if (process.env.SHOW) console.log(t);
}
