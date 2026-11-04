/**
 * Mutações: planta um erro conhecido numa nota válida e diz o que o validador
 * precisa apontar. Usado pela varredura (test/gen/mutsweep.ts) e pelo vitest.
 */
import type { Analysis, Finding } from '../../src/core/types';
import { analyze, type Engine } from '../../src/core/analyze';
import { valueFixFor, insertFixFor } from '../../src/core/fixes';
import { toXml, toTx2, type GenNote, type MGroup } from './nota';

export interface Mutation {
  name: string;
  /** altera o modelo (cópia) */
  apply: (m: MGroup) => void;
  /** acha o achado esperado */
  match: (f: Finding) => boolean;
  /** tag que a linha do achado deve mostrar (para conferir a linha) */
  tag?: string;
  /** valor que a correção deve sugerir (o original); número compara numericamente */
  fix?: string;
  /** valor esperado numa prévia de tag que falta */
  ghost?: string;
  /** a prévia pode vir sem valor ("…") quando a conta não é conclusiva; valor errado nunca */
  ghostOptional?: boolean;
  /** depois de aplicar a correção (ou inserir), a nota tem que ficar limpa */
  roundTrip?: 'value' | 'insert';
  /** achados que não podem aparecer (ex.: total quando o erro é do item) */
  forbid?: (f: Finding) => boolean;
}

const det = (m: MGroup, k: number) => (m.det as MGroup[])[k];
const prod = (m: MGroup, k: number) => det(m, k).prod as MGroup;
const imp = (m: MGroup, k: number) => det(m, k).imposto as MGroup;
const icms = (m: MGroup, k: number) => Object.values(imp(m, k).ICMS as MGroup)[0] as MGroup;
const tot = (m: MGroup) => (m.total as MGroup).ICMSTot as MGroup;
const ibsTot = (m: MGroup) => (m.total as MGroup).IBSCBSTot as MGroup | undefined;
const add = (v: string, d: number) => (+v + d).toFixed(2);

export function mutationsFor(g: GenNote): Mutation[] {
  const M: Mutation[] = [];
  const m = g.model;
  const n = g.items.length;
  const k = n - 1; // último item
  const it = g.items[k];

  // --- item x total ---
  M.push({
    name: 'vProd do item errado (total certo)', apply: (x) => { prod(x, k).vProd = add(prod(x, k).vProd as string, 0.37); },
    match: (f) => f.code === '629', tag: 'vProd', fix: prod(m, k).vProd as string, roundTrip: 'value',
    forbid: (f) => /^Total vProd|^Total da nota/.test(f.title),
  });
  M.push({
    name: 'total vProd errado', apply: (x) => { tot(x).vProd = add(tot(x).vProd as string, 1); },
    match: (f) => f.code === '564' && /^Total/.test(f.title), tag: 'vProd', fix: tot(m).vProd as string, roundTrip: 'value',
    forbid: (f) => /^Total da nota/.test(f.title),
  });
  M.push({
    name: 'total vNF errado', apply: (x) => { tot(x).vNF = add(tot(x).vNF as string, 2); },
    match: (f) => f.code === '610', tag: 'vNF', fix: tot(m).vNF as string, roundTrip: 'value',
    forbid: (f) => /Pagamentos não fecham|duplicatas|fatura/.test(f.title),
  });
  const kI = g.items.findIndex((i) => ['00', '20', '10'].includes(i.cst));
  if (kI >= 0) {
    M.push({
      name: `vICMS do item errado (CST ${g.items[kI].cst})`, apply: (x) => { icms(x, kI).vICMS = add(icms(x, kI).vICMS as string, 1); },
      match: (f) => /^vICMS diferente de vBC × pICMS/.test(f.title), tag: 'vICMS', fix: icms(m, kI).vICMS as string, roundTrip: 'value',
      forbid: (f) => /^Total vICMS /.test(f.title) || /^vICMSST diferente/.test(f.title),
    });
    M.push({
      name: 'total vICMS errado', apply: (x) => { tot(x).vICMS = add(tot(x).vICMS as string, 1); },
      match: (f) => f.code === '532' && /^Total/.test(f.title), tag: 'vICMS', fix: tot(m).vICMS as string, roundTrip: 'value',
    });
    M.push({
      name: 'total vBC errado', apply: (x) => { tot(x).vBC = add(tot(x).vBC as string, 5); },
      match: (f) => f.code === '531' && /^Total/.test(f.title), tag: 'vBC', fix: tot(m).vBC as string, roundTrip: 'value',
    });
  }
  const kS = g.items.findIndex((i) => i.cst === '10');
  if (kS >= 0) {
    M.push({
      name: 'vICMSST do item errado', apply: (x) => { icms(x, kS).vICMSST = add(icms(x, kS).vICMSST as string, 3); },
      match: (f) => /^vICMSST diferente/.test(f.title), tag: 'vICMSST', fix: icms(m, kS).vICMSST as string, roundTrip: 'value',
      forbid: (f) => /^Total vST|^Total da nota/.test(f.title),
    });
    M.push({
      name: 'total vST errado', apply: (x) => { tot(x).vST = add(tot(x).vST as string, 3); },
      match: (f) => f.code === '534' && /^Total vST/.test(f.title), tag: 'vST', fix: tot(m).vST as string, roundTrip: 'value',
      forbid: (f) => /^Total da nota/.test(f.title),
    });
  }
  const kP = g.items.findIndex((i) => i.vIPI > 0);
  if (kP >= 0) {
    const ipi = (x: MGroup) => (imp(x, kP).IPI as MGroup).IPITrib as MGroup;
    M.push({
      name: 'vIPI do item errado', apply: (x) => { ipi(x).vIPI = add(ipi(x).vIPI as string, 1); },
      match: (f) => /^vIPI diferente/.test(f.title), tag: 'vIPI', fix: ipi(m).vIPI as string, roundTrip: 'value',
      forbid: (f) => /^Total da nota|^Total vIPI/.test(f.title),
    });
  }
  const kC = g.items.findIndex((i) => i.vPIS > 0);
  if (kC >= 0) {
    const pis = (x: MGroup) => (imp(x, kC).PIS as MGroup).PISAliq as MGroup;
    M.push({
      name: 'vPIS do item errado', apply: (x) => { pis(x).vPIS = add(pis(x).vPIS as string, 0.5); },
      match: (f) => /^vPIS diferente/.test(f.title), tag: 'vPIS', fix: pis(m).vPIS as string, roundTrip: 'value',
      forbid: (f) => /^Total vPIS/.test(f.title),
    });
  }

  // --- CST 51 ---
  const k51 = g.items.findIndex((i) => i.cst === '51');
  if (k51 >= 0) {
    const i51 = g.items[k51];
    M.push({
      name: 'CST 51 sem pRedBC', apply: (x) => { delete icms(x, k51).pRedBC; },
      match: (f) => f.code === '929', ghost: i51.pRedBC, ghostOptional: true, roundTrip: 'insert',
    });
    M.push({
      name: 'CST 51 sem pDif', apply: (x) => { delete icms(x, k51).pDif; },
      match: (f) => f.code === '929', ghost: i51.pDif, ghostOptional: true, roundTrip: 'insert',
    });
    M.push({
      name: 'vICMSOp errado (CST 51)', apply: (x) => { icms(x, k51).vICMSOp = add(icms(x, k51).vICMSOp as string, 2); },
      match: (f) => /^vICMSOp diferente/.test(f.title), tag: 'vICMSOp', fix: icms(m, k51).vICMSOp as string, roundTrip: 'value',
      forbid: (f) => /^vICMSDif diferente|^vICMS diferente de vICMSOp/.test(f.title),
    });
  }

  // --- IBS/CBS ---
  if (g.ibs) {
    const gi = (x: MGroup, kk: number) => (imp(x, kk).IBSCBS as MGroup).gIBSCBS as MGroup;
    const uf = (x: MGroup, kk: number) => gi(x, kk).gIBSUF as MGroup;
    M.push({
      name: 'vIBSUF do item errado', apply: (x) => { uf(x, k).vIBSUF = add(uf(x, k).vIBSUF as string, 0.05); },
      match: (f) => /^vIBSUF diferente/.test(f.title), tag: 'vIBSUF', fix: uf(m, k).vIBSUF as string, roundTrip: 'value',
      forbid: (f) => /^Total vIBSUF/.test(f.title) || /^vIBS diferente/.test(f.title),
    });
    M.push({
      name: 'total vIBSUF errado', apply: (x) => { const t = (ibsTot(x)!.gIBS as MGroup).gIBSUF as MGroup; t.vIBSUF = add(t.vIBSUF as string, 0.5); },
      match: (f) => f.code === '1080' && /^Total vIBSUF/.test(f.title), tag: 'vIBSUF', fix: (((ibsTot(m)!.gIBS as MGroup).gIBSUF as MGroup).vIBSUF as string), roundTrip: 'value',
    });
    if (n >= 2) {
      M.push({
        name: 'item sem grupo IBSCBS', apply: (x) => { delete imp(x, k).IBSCBS; },
        match: (f) => /sem grupo IBSCBS/.test(f.title),
        ghost: it.ibsBase !== undefined ? it.ibsBase.toFixed(2) : undefined, ghostOptional: true,
      });
    }
  }

  // --- formatos (a correção tem que devolver o valor original) ---
  const vp = prod(m, 0).vProd as string;
  M.push({
    name: 'vírgula decimal', apply: (x) => { prod(x, 0).vProd = (+vp).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); },
    match: (f) => f.code === '225' && /vProd/.test(f.title), tag: 'vProd', fix: vp, roundTrip: 'value',
  });
  const cep = ((m.dest as MGroup).enderDest as MGroup).CEP as string;
  M.push({
    name: 'CEP com traço', apply: (x) => { ((x.dest as MGroup).enderDest as MGroup).CEP = cep.slice(0, 5) + '-' + cep.slice(5); },
    match: (f) => f.code === '225' && /CEP/.test(f.title), tag: 'CEP', fix: cep, roundTrip: 'value',
  });
  const ncm = prod(m, 0).NCM as string;
  M.push({
    name: 'NCM com pontos', apply: (x) => { prod(x, 0).NCM = `${ncm.slice(0, 4)}.${ncm.slice(4, 6)}.${ncm.slice(6)}`; },
    match: (f) => f.code === '225' && /NCM/.test(f.title), tag: 'NCM', fix: ncm, roundTrip: 'value',
  });
  const xp = prod(m, 0).xProd as string;
  M.push({
    name: 'espaço no fim do xProd', apply: (x) => { prod(x, 0).xProd = xp + ' '; },
    match: (f) => f.code === '225' && /xProd/.test(f.title), tag: 'xProd', fix: xp, roundTrip: 'value',
  });
  const xn = (m.emit as MGroup).xNome as string;
  M.push({
    name: 'caractere corrompido no xNome', apply: (x) => { (x.emit as MGroup).xNome = xn.replace(' ', '� '); },
    match: (f) => f.code === '225' && /xNome/.test(f.title), tag: 'xNome', fix: xn, roundTrip: 'value',
  });

  // --- chave, datas ---
  const id = m['@Id'] as string;
  M.push({
    name: 'chave com número errado', apply: (x) => { x['@Id'] = id.slice(0, 28) + (id[28] === '9' ? '8' : '9') + id.slice(29); },
    match: (f) => f.code === '502', fix: id, roundTrip: 'value',
  });
  const ide = m.ide as MGroup;
  M.push({
    name: 'cDV errado', apply: (x) => { (x.ide as MGroup).cDV = String((+(ide.cDV as string) + 1) % 10); },
    match: (f) => f.title === 'cDV diferente do dígito da chave', tag: 'cDV', fix: ide.cDV as string, roundTrip: 'value',
  });
  M.push({
    name: 'saída antes da emissão', apply: (x) => { (x.ide as MGroup).dhSaiEnt = (ide.dhEmi as string).replace(/-(\d{2})T/, (_, d) => `-${String(+d - 1).padStart(2, '0')}T`); },
    match: (f) => f.code === '506', tag: 'dhSaiEnt', fix: ide.dhSaiEnt as string, roundTrip: 'value',
  });
  // cenário real: servidor com horário de verão desatualizado (mesmo instante, hora local +1 e fuso -02:00)
  const shift = (dh: string, from: string, to: string, h: number) => dh.replace(/T(\d{2})/, (_, x) => `T${String(+x + h).padStart(2, '0')}`).replace(new RegExp(from + '$'), to);
  if (g.uf !== 'MT') {
    M.push({
      name: 'fuso -02:00 (horário de verão no servidor)', apply: (x) => { (x.ide as MGroup).dhEmi = shift(ide.dhEmi as string, '-03:00', '-02:00', 1); (x.ide as MGroup).dhSaiEnt = shift(ide.dhSaiEnt as string, '-03:00', '-02:00', 1); },
      match: (f) => /^Fuso horário de dhEmi/.test(f.title), tag: 'dhEmi', fix: ide.dhEmi as string,
    });
  } else {
    M.push({
      name: 'fuso -03:00 em MT', apply: (x) => { (x.ide as MGroup).dhEmi = shift(ide.dhEmi as string, '-04:00', '-03:00', 1); (x.ide as MGroup).dhSaiEnt = shift(ide.dhSaiEnt as string, '-04:00', '-03:00', 1); },
      match: (f) => /^Fuso horário de dhEmi/.test(f.title), tag: 'dhEmi', fix: ide.dhEmi as string,
    });
  }

  // --- tags que faltam / vazias ---
  M.push({
    name: 'cEnq vazio', apply: (x) => { (imp(x, 0).IPI as MGroup).cEnq = ''; },
    match: (f) => f.code === '225' && /cEnq/.test(f.title), tag: 'cEnq',
  });
  M.push({
    name: 'sem natOp', apply: (x) => { delete (x.ide as MGroup).natOp; },
    match: (f) => f.code === '225' && /natOp/.test(f.title),
  });
  const cobr = m.cobr as MGroup | undefined;
  if (cobr && (cobr.dup as MGroup[]).length) {
    M.push({
      name: 'duplicata com valor errado', apply: (x) => { const d = ((x.cobr as MGroup).dup as MGroup[]).at(-1)!; d.vDup = add(d.vDup as string, 1); },
      match: (f) => /duplicatas/.test(f.title),
    });
  }
  return M;
}

/* ------------------------------------------------------------------ */
/* Execução de uma mutação num formato                                 */
/* ------------------------------------------------------------------ */
export interface MutResult { ok: boolean; problems: string[]; }

const lineText = (a: Analysis, text: string, line?: number) => (line ? (a.kind === 'tx2' ? text : a.source).split(/\r?\n/)[line - 1] ?? '' : '');
const sameNum = (a?: string, b?: string) => a !== undefined && b !== undefined && (a === b || (!isNaN(+a) && !isNaN(+b) && Math.abs(+a - +b) < 1e-9));

export async function runMutation(g: GenNote, mu: Mutation, kind: 'xml' | 'tx2', eng: Engine): Promise<MutResult> {
  const problems: string[] = [];
  const model = structuredClone(g.model);
  mu.apply(model);
  const g2 = { ...g, model };
  const text = kind === 'xml' ? toXml(g2) : toTx2(g2);
  const [a] = await analyze(text, eng);
  const hit = a.findings.find(mu.match);
  const list = () => a.findings.filter((f) => f.sev !== 'info').map((f) => `${f.sev}${f.code ? ' ' + f.code : ''} L${f.line} ${f.title}`).join(' | ');
  if (!hit) return { ok: false, problems: [`não achou o erro plantado. Achados: ${list() || '(nenhum)'}`] };
  if (mu.tag) {
    const l = lineText(a, text, hit.line);
    const okLine = kind === 'tx2' ? l.replace(/^\d+/, '').startsWith(mu.tag + '_') : l.includes(`<${mu.tag}`);
    if (!okLine) problems.push(`linha ${hit.line} não é a do campo ${mu.tag}: "${l.trim()}"`);
  }
  if (mu.fix !== undefined && !sameNum(hit.fix?.value, mu.fix)) problems.push(`correção sugerida "${hit.fix?.value}" ≠ original "${mu.fix}"`);
  if (mu.ghost !== undefined) {
    const gs = hit.ghosts ?? [];
    const vals = gs.flatMap((x) => x.text.split('\n').map((l) => (x.format === 'tx2' ? l.split('=')[1] : />([^<]*)</.exec(l)?.[1])));
    const field = mu.name.includes('pDif') ? 'pDif' : mu.name.includes('pRedBC') ? 'pRedBC' : 'vBC';
    const mine = gs.flatMap((x) => x.text.split('\n')).filter((l) => (x => x)(l).includes(field));
    const vMine = mine.map((l) => (l.includes('=') ? l.split('=')[1] : />([^<]*)</.exec(l)?.[1]));
    if (!vals.some((v) => sameNum(v, mu.ghost))) {
      const unknown = vMine.length > 0 && vMine.every((v) => v === '…');
      if (!(mu.ghostOptional && unknown)) problems.push(`prévia sem o valor original ${mu.ghost}: ${gs.map((x) => x.text.replace(/\n/g, ' ')).join(' ; ') || '(sem prévia)'}`);
    }
  }
  if (mu.forbid) {
    const bad = a.findings.filter(mu.forbid);
    if (bad.length) problems.push(`achado indevido: ${bad.map((f) => `${f.code ?? ''} ${f.title} (sugere ${f.fix?.value ?? '-'})`).join(' | ')}`);
  }
  if (mu.roundTrip) {
    const base = a.kind === 'tx2' ? text : a.source;
    const fn = mu.roundTrip === 'value' ? valueFixFor(hit, a.kind) : insertFixFor(hit);
    const fixed = fn?.(base);
    if (!fixed && mu.roundTrip === 'insert' && mu.ghostOptional) { /* valor não conclusivo: sem inserção automática */ }
    else if (!fixed) problems.push('não deu para aplicar a correção no texto');
    else {
      const [b] = await analyze(fixed, eng);
      const rest = b.findings.filter((f) => f.sev !== 'info');
      if (rest.length) problems.push(`depois de aplicar, sobrou: ${rest.map((f) => `${f.sev} ${f.code ?? ''} L${f.line} ${f.title}`).join(' | ')}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
