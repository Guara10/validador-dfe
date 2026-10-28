// Uso: npx vite-node test/run-file.ts <arquivo>  (diagnóstico rápido no terminal)
import { readFileSync } from 'node:fs';
import { analyze } from '../src/core/analyze';
import { nfeDict, nfeSchemas } from '../src/core/engine-data';
import { nodeRunner } from './node-runner';

const file = process.argv[2];
const res = await analyze(readFileSync(file, 'latin1').includes('�') ? readFileSync(file, 'utf8') : readFileSync(file, 'utf8'), { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas });
for (const a of res) {
  console.log(`== ${a.kind} | schemaOk=${a.schemaOk} | ${JSON.stringify(a.summary)}`);
  for (const f of a.findings) console.log(`[${f.sev}${f.code ? ' ' + f.code : ''}] L${f.line ?? '?'} ${f.tx2Field ?? ''} ${f.title}\n    ${f.message}${f.found ? `\n    encontrado: ${f.found}` : ''}${f.expected ? `\n    esperado: ${f.expected}` : ''}${f.fix ? `\n    correção: ${f.fix.text}${f.fix.value ? ' -> ' + f.fix.value : ''}` : ''}`);
  if (a.ignoredTx2?.length) console.log('ignorados:', a.ignoredTx2.map((x) => x.field).join(', '));
  if (process.env.SHOWXML && a.generatedXml) console.log(a.generatedXml);
}
