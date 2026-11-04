// Varredura de mutações: npx vite-node test/gen/mutsweep.ts <n de notas> [seed inicial]
import { genNote } from './nota';
import { mutationsFor, runMutation } from './mutations';
import { nfeDict, nfeSchemas } from '../../src/core/engine-data';
import { nodeRunner } from '../node-runner';
const eng = { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas, now: () => new Date('2026-10-28T12:00:00-03:00') };
const n = +(process.argv[2] ?? 10), s0 = +(process.argv[3] ?? 1);
const t0 = Date.now();
let runs = 0;
const fails = new Map<string, string[]>();
for (let seed = s0; seed < s0 + n; seed++) {
  // metade das notas com perfil forçado para cobrir ST, CST 51, IPI e IBS com vários itens
  const g = genNote(seed, seed % 2 ? {} : { crt: '3', ibs: true, items: 3, csts: ['00', '51', '10'], pf: false });
  for (const mu of mutationsFor(g)) for (const kind of ['tx2', 'xml'] as const) {
    runs++;
    const r = await runMutation(g, mu, kind, eng);
    if (!r.ok) {
      const key = `${mu.name} [${kind}]`;
      if (!fails.has(key)) fails.set(key, []);
      fails.get(key)!.push(`seed ${seed}: ${r.problems.join(' || ')}`);
    }
  }
}
console.log(`${runs} mutações em ${n} notas, ${((Date.now() - t0) / 1000).toFixed(0)}s; tipos com falha: ${fails.size}`);
for (const [k, v] of fails) console.log(`\n### ${k} (${v.length})\n  ` + v.slice(0, 3).join('\n  '));
