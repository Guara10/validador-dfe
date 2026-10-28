import type { XNode, Finding } from '../types';
import { Dict, type DNode, type Group, maxOf } from '../dict';
import { dictPath } from '../xml/parse';
import { chaveFromIde } from '../rules/nfe';

/* ------------------------------------------------------------------ */
/* Leitura do TX2                                                      */
/* ------------------------------------------------------------------ */

export interface Tx2Field {
  line: number;
  field: string; // nome completo como está no arquivo
  tag: string; // nome da tag (ex.: vICMS)
  id: string; // id do leiaute (ex.: N17)
  letters: string; // N
  idNum: number; // 17
  idSuf: string; // '' | 'a' | 'b'...
  idx?: number; // índice de repetição (_1)
  part?: { name: string; n: number }; // INCLUIRPARTE
  value: string;
  item?: number; // número do item (INCLUIRITEM)
}
export interface Tx2Note {
  fields: Tx2Field[];
  unknown: { line: number; field: string }[];
  startLine: number;
  endLine: number;
  problems: Finding[];
}

const FIELD = /^(\d*)([A-Za-z][A-Za-z0-9]*)_([A-Z]{1,2})(\d{1,3})([a-z]?)(?:_(\d+))?$/;

export function looksLikeTx2(text: string): boolean {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('<')) return false;
  return /^\s*(INCLUIR|formato\s*=\s*tx2|[A-Za-z]+_[A-Z]{1,2}\d+[a-z]?\s*=)/im.test(t);
}

export function parseTx2(text: string): Tx2Note[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const notes: Tx2Note[] = [];
  let cur: Tx2Note | undefined;
  let item: number | undefined;
  let itemCount = 0;
  let part: { name: string; n: number } | undefined;
  const partCount = new Map<string, number>();
  const newNote = (line: number) => {
    cur = { fields: [], unknown: [], startLine: line, endLine: line, problems: [] };
    notes.push(cur);
    item = undefined; itemCount = 0; part = undefined; partCount.clear();
  };
  lines.forEach((raw, i) => {
    const line = i + 1;
    const s = raw.replace(/\r$/, '');
    const t = s.trim();
    if (!t || t.startsWith('*') || t.startsWith('//') || t.startsWith('#')) return;
    const up = t.toUpperCase();
    if (up === 'INCLUIR') { newNote(line); return; }
    if (up === 'SALVAR') { if (cur) cur.endLine = line; if (item !== undefined && cur) cur.problems.push(tx2Problem(line, 'SALVAR com item aberto', `O item ${item} foi aberto com INCLUIRITEM e não tem SALVARITEM antes do SALVAR.`, 'Inclua SALVARITEM no fim do bloco do item.')); item = undefined; return; }
    if (up === 'INCLUIRITEM') {
      if (!cur) newNote(line);
      if (item !== undefined) cur!.problems.push(tx2Problem(line, 'INCLUIRITEM sem fechar o item anterior', `O item ${item} não tem SALVARITEM antes do próximo INCLUIRITEM.`, 'Inclua SALVARITEM no fim do bloco do item anterior.'));
      item = ++itemCount; return;
    }
    if (up === 'SALVARITEM') {
      if (item === undefined && cur) cur.problems.push(tx2Problem(line, 'SALVARITEM sem INCLUIRITEM', 'Há um SALVARITEM sem item aberto.', 'Remova a linha ou inclua o INCLUIRITEM correspondente.'));
      item = undefined; return;
    }
    if (up.startsWith('INCLUIRPARTE')) {
      const name = t.split('=')[1]?.trim().toUpperCase() ?? '';
      const key = (item ?? 0) + '|' + name;
      const n = (partCount.get(key) ?? 0) + 1;
      partCount.set(key, n);
      part = { name, n };
      return;
    }
    if (up === 'SALVARPARTE') { part = undefined; return; }
    const eq = s.indexOf('=');
    if (eq < 0) { if (cur) cur.unknown.push({ line, field: t }); return; }
    const name = s.slice(0, eq).trim();
    const value = s.slice(eq + 1);
    if (/^(formato|numlote)$/i.test(name)) return;
    if (!cur) newNote(line);
    const m = FIELD.exec(name);
    if (!m) { cur!.unknown.push({ line, field: name }); return; }
    cur!.fields.push({
      line, field: name, tag: m[2], id: m[3] + m[4] + m[5], letters: m[3], idNum: +m[4], idSuf: m[5], idx: m[6] ? +m[6] : undefined,
      part: part ? { ...part } : undefined, value, item,
    });
    cur!.endLine = line;
  });
  if (cur && item !== undefined) cur.problems.push(tx2Problem(cur.endLine, 'Item sem SALVARITEM', `O item ${item} não foi fechado com SALVARITEM.`, 'Inclua SALVARITEM no fim do bloco do item.'));
  return notes;
}

function tx2Problem(line: number, title: string, message: string, fix: string): Finding {
  return { sev: 'erro', origin: 'estrutura', title, message, line, fix: { text: fix } };
}

/* ------------------------------------------------------------------ */
/* TX2 -> árvore XML seguindo o XSD                                    */
/* ------------------------------------------------------------------ */

/** Grupo do leiaute indicado pela letra do ID (MOC, Anexo I). Caminho relativo a infNFe. */
const GROUP: Record<string, string> = {
  A: '', B: 'ide', BA: 'ide/NFref', C: 'emit', D: 'avulsa', E: 'dest', F: 'retirada', G: 'entrega', GA: 'autXML',
  H: 'det', I: 'det/prod', J: 'det/prod/veicProd', K: 'det/prod/med', L: 'det/prod', LA: 'det/prod/comb', LB: 'det/prod',
  M: 'det/imposto', N: 'det/imposto/ICMS', NA: 'det/imposto/ICMSUFDest', O: 'det/imposto/IPI', P: 'det/imposto/II',
  Q: 'det/imposto/PIS', R: 'det/imposto/PISST', S: 'det/imposto/COFINS', T: 'det/imposto/COFINSST', U: 'det/imposto/ISSQN',
  UA: 'det/impostoDevol', UB: 'det/imposto', V: 'det', VA: 'det/obsItem', VB: 'det', VC: 'det',
  W: 'total', X: 'transp', Y: 'cobr', YA: 'pag', YB: 'infIntermed', Z: 'infAdic', ZA: 'exporta', ZB: 'compra', ZC: 'cana', ZD: 'infRespTec',
};
const ITEM_LETTERS = /^(H|I|J|K|L|LA|LB|M|N|NA|O|P|Q|R|S|T|U|UA|UB|V|VA|VB|VC)$/;

interface Placed { f: Tx2Field; cands: DNode[]; }

export interface BuildResult {
  root: XNode;
  ignored: { line: number; field: string }[];
  /** campos vazios do TX2, para explicar "falta a tag X" */
  empties: { f: Tx2Field; cands: DNode[] }[];
  problems: Finding[];
  idGenerated: boolean;
}

function cmpId(a: Tx2Field, b: Tx2Field) {
  return a.idNum - b.idNum || a.idSuf.localeCompare(b.idSuf);
}

export function buildFromTx2(note: Tx2Note, dict: Dict): BuildResult {
  const problems: Finding[] = [...note.problems];
  const ignored = [...note.unknown];
  const infPath = 'NFe/infNFe';

  const candidates = (f: Tx2Field): DNode[] => {
    const isItem = ITEM_LETTERS.test(f.letters);
    const g = GROUP[f.letters];
    const pool = (f.tag === 'Id' || f.tag === 'versao' || f.tag === 'nItem') ? dict.byName.get('@' + f.tag) ?? [] : dict.byName.get(f.tag) ?? [];
    let c = pool.filter((n) => n.path.startsWith(infPath + '/') || n.path.startsWith(infPath + '/@'));
    if (g !== undefined) {
      const pre = g ? `${infPath}/${g}/` : `${infPath}/`;
      const inGroup = c.filter((n) => n.path.startsWith(pre) || (g && n.path === `${infPath}/${g}/@${f.tag}`));
      if (inGroup.length) c = inGroup;
      else if (g === '' ) c = c.filter((n) => n.path === `${infPath}/@${f.tag}`);
      else c = []; // a letra diz um grupo e a tag não existe nele
    }
    if (f.letters === 'UB') c = c.filter((n) => /\/imposto\/(IBSCBS|IS)\//.test(n.path));
    c = c.filter((n) => (isItem ? n.path.startsWith(infPath + '/det/') || n.path === infPath + '/det/@nItem' : !n.path.startsWith(infPath + '/det/')));
    return c;
  };

  // --- separa por escopo (nota / item) ---
  const scopes = new Map<string, Placed[]>();
  const empties: BuildResult['empties'] = [];
  for (const f of note.fields) {
    const isItem = ITEM_LETTERS.test(f.letters);
    if (isItem && f.item === undefined) {
      problems.push({ sev: 'erro', origin: 'estrutura', title: `Campo de item fora de INCLUIRITEM: ${f.field}`, message: 'Campos dos grupos de produto e impostos precisam estar entre INCLUIRITEM e SALVARITEM.', line: f.line, tx2Field: f.field, fix: { text: 'Mova a linha para dentro do bloco do item.' } });
      continue;
    }
    const cands = candidates(f);
    if (!cands.length) { ignored.push({ line: f.line, field: f.field }); continue; }
    if (f.value === '') { empties.push({ f, cands }); continue; }
    const key = isItem ? 'item' + f.item : 'nota';
    if (!scopes.has(key)) scopes.set(key, []);
    scopes.get(key)!.push({ f, cands });
  }

  // --- escolha de ramos (xs:choice) por escopo ---
  for (const [, placed] of scopes) resolveChoices(placed, dict);
  // empties: só para explicar; mesmo filtro de ramos não é necessário

  // --- duplicados ---
  const seen = new Map<string, Tx2Field>();
  for (const [scope, placed] of scopes) {
    for (const p of placed) {
      const k = scope + '|' + p.cands[0].path + '|' + (p.f.idx ?? '') + '|' + (p.f.part ? p.f.part.name + p.f.part.n : '');
      const prev = seen.get(k);
      if (prev) problems.push({ sev: 'aviso', origin: 'estrutura', title: `Campo repetido: ${p.f.field}`, message: `${p.f.field} já foi informado na linha ${prev.line}. Só o último valor deve valer.`, line: p.f.line, tx2Field: p.f.field, fix: { text: 'Remova uma das linhas.' } });
      seen.set(k, p.f);
    }
  }

  // --- monta a árvore ---
  const nodeByKey = new Map<string, XNode>();
  const root: XNode = { name: 'NFe', attrs: [{ name: 'xmlns', value: 'http://www.portalfiscal.inf.br/nfe', raw: 'http://www.portalfiscal.inf.br/nfe' }], children: [], line: 0 };
  const inf: XNode = { name: 'infNFe', attrs: [], children: [], line: 0, parent: root };
  root.children.push(inf);
  nodeByKey.set(infPath, inf);
  const order = new WeakMap<XNode, number>();
  const inst = new WeakMap<XNode, number>();

  const ensure = (dn: DNode, f: Tx2Field): XNode => {
    // cadeia de ancestrais abaixo de infNFe
    const chain: DNode[] = [];
    for (let c: DNode | undefined = dn; c && c.path !== infPath; c = c.parent) chain.unshift(c);
    // ancestral repetível mais próximo (fora det) recebe o índice _n / parte
    const repIdx = (c: DNode) => {
      if (c.n === 'det' && c.path === infPath + '/det') return f.item ?? 1;
      return 1;
    };
    let nearestRep: DNode | undefined;
    for (const c of chain) if (maxOf(c) > 1 && !(c.n === 'det' && c.path === infPath + '/det')) nearestRep = c;
    const rep = f.idx ?? f.part?.n ?? 1;
    let parent = inf;
    let key = infPath;
    for (const c of chain) {
      const i = c === nearestRep ? rep : repIdx(c);
      key += '/' + c.n + (i > 1 || maxOf(c) > 1 ? '#' + i : '');
      let node = nodeByKey.get(key);
      if (!node) {
        node = { name: c.n, attrs: [], children: [], line: 0, parent };
        order.set(node, c.o);
        inst.set(node, i);
        parent.children.push(node);
        nodeByKey.set(key, node);
      }
      parent = node;
    }
    return parent;
  };

  for (const [, placed] of scopes) {
    for (const p of placed) {
      const dn = p.cands[0];
      if (dn.k === 'a') {
        const owner = dn.parent!.path === infPath ? inf : ensure(dn.parent!, p.f);
        const old = owner.attrs.find((a) => a.name === dn.n);
        if (old) owner.attrs.splice(owner.attrs.indexOf(old), 1);
        owner.attrs.push({ name: dn.n, value: p.f.value, raw: p.f.value, tx2Line: p.f.line, tx2Field: p.f.field });
        continue;
      }
      const node = ensure(dn, p.f);
      node.text = p.f.value;
      node.raw = p.f.value;
      node.tx2Line = p.f.line;
      node.tx2Field = p.f.field;
    }
  }

  // ordena filhos conforme o XSD
  const sortRec = (n: XNode) => {
    n.children.sort((a, b) => (order.get(a)! - order.get(b)!) || (inst.get(a)! - inst.get(b)!));
    n.children.forEach(sortRec);
  };
  sortRec(inf);

  // atributos obrigatórios
  if (!inf.attrs.find((a) => a.name === 'versao')) inf.attrs.push({ name: 'versao', value: '4.00', raw: '4.00' });
  let idGenerated = false;
  const idA = inf.attrs.find((a) => a.name === 'Id');
  if (!idA) {
    const ch = chaveFromIde(inf);
    inf.attrs.push({ name: 'Id', value: 'NFe' + (ch ?? '0'.repeat(44)), raw: 'NFe' + (ch ?? '0'.repeat(44)) });
    idGenerated = true;
  }
  inf.attrs.sort((a, b) => (a.name === 'versao' ? -1 : b.name === 'versao' ? 1 : 0));
  for (const det of inf.children.filter((c) => c.name === 'det')) {
    if (!det.attrs.find((a) => a.name === 'nItem')) det.attrs.push({ name: 'nItem', value: String(inst.get(det)), raw: String(inst.get(det)) });
  }

  // linha do TX2 para grupos: primeira linha de um descendente
  const lineRec = (n: XNode): number | undefined => {
    let min = n.tx2Line ?? n.attrs.find((a) => a.tx2Line)?.tx2Line;
    for (const c of n.children) {
      const l = lineRec(c);
      if (l !== undefined && (min === undefined || l < min)) min = l;
    }
    if (n.tx2Line === undefined) n.tx2Line = min;
    return min;
  };
  lineRec(root);

  return { root, ignored, empties, problems, idGenerated };
}

/**
 * Decide os ramos de xs:choice (ex.: ICMS00 x ICMS51, IPITrib x IPINT, PISAliq x PISNT)
 * usando os campos com lista de valores (CST/CSOSN) como discriminadores,
 * e depois desfaz ambiguidades restantes pela ordem dos IDs do leiaute.
 */
function resolveChoices(placed: Placed[], dict: Dict) {
  const score = new Map<Group, Map<number, number>>();
  const add = (g: Group, i: number, v: number) => {
    if (!score.has(g)) score.set(g, new Map());
    const m = score.get(g)!;
    m.set(i, (m.get(i) ?? 0) + v);
  };
  for (const p of placed) {
    for (const c of p.cands) {
      const brs = dict.branchesUpTo(c, dict.root);
      const enumHit = c.f?.e ? (c.f.e.includes(p.f.value) ? 10 : -10) : 0;
      for (const b of brs) add(b.choice, b.index, 1 + enumHit);
    }
  }
  const chosen = new Map<Group, number>();
  for (const [g, m] of score) {
    let best = -Infinity, bi = 0;
    for (const [i, v] of m) if (v > best) { best = v; bi = i; }
    chosen.set(g, bi);
  }
  for (const p of placed) {
    const ok = p.cands.filter((c) => dict.branchesUpTo(c, dict.root).every((b) => chosen.get(b.choice) === b.index));
    if (ok.length) p.cands = ok;
  }
  // âncoras: campos sem ambiguidade, mesma letra
  const anchors = placed.filter((p) => p.cands.length === 1);
  for (const p of placed) {
    if (p.cands.length < 2) continue;
    const same = anchors.filter((a) => a.f.letters === p.f.letters && a !== p);
    const prev = same.filter((a) => cmpId(a.f, p.f) < 0).sort((a, b) => cmpId(b.f, a.f))[0];
    const next = same.filter((a) => cmpId(a.f, p.f) > 0).sort((a, b) => cmpId(a.f, b.f))[0];
    const lo = prev?.cands[0].o ?? -Infinity, hi = next?.cands[0].o ?? Infinity;
    const between = p.cands.filter((c) => c.o > lo && c.o < hi);
    if (between.length) p.cands = between;
    p.cands.sort((a, b) => a.o - b.o);
  }
}

/** Para mensagens: se um campo obrigatório ausente estava vazio no TX2. */
export function makeEmptyLookup(b: BuildResult) {
  return (parent: XNode, name: string) => {
    const pPath = dictPath(parent);
    let item: number | undefined;
    for (let c: XNode | undefined = parent; c; c = c.parent) if (c.name === 'det') item = +(c.attrs.find((a) => a.name === 'nItem')?.value ?? 0) || undefined;
    const hit = b.empties.find((e) => e.f.tag === name && e.cands.some((c) => c.path === pPath + '/' + name) && (item === undefined || e.f.item === item));
    return hit ? { line: hit.f.line, field: hit.f.field } : undefined;
  };
}
