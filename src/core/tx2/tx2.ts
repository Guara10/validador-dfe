import type { XNode, Finding } from '../types';
import { Dict, type DNode, type Group, type Particle, maxOf, valueOk } from '../dict';
import type { Ghost } from '../types';
import { requiredLeaves } from '../ghost';
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
  /** arquivo acabou sem SALVAR */
  incomplete?: boolean;
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
  let closed = false;
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
    if (up === 'INCLUIR') {
      if (cur && !closed) cur.problems.push(tx2Problem(line, 'INCLUIR sem SALVAR da nota anterior', `A nota iniciada na linha ${cur.startLine} não tem SALVAR antes deste INCLUIR.`, 'Inclua SALVAR no fim do bloco da nota anterior.'));
      newNote(line); closed = false; return;
    }
    if (up === 'SALVAR') { if (cur) cur.endLine = line; if (item !== undefined && cur) cur.problems.push(tx2Problem(line, 'SALVAR com item aberto', `O item ${item} foi aberto com INCLUIRITEM e não tem SALVARITEM antes do SALVAR.`, 'Inclua SALVARITEM no fim do bloco do item.')); item = undefined; closed = true; return; }
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
    if (up.startsWith('SALVARPARTE')) { part = undefined; return; }
    const eq = s.indexOf('=');
    if (eq < 0) { if (cur) cur.unknown.push({ line, field: t }); return; }
    const name = s.slice(0, eq).trim();
    const value = s.slice(eq + 1);
    if (/^(formato|numlote)$/i.test(name)) return;
    // depois do SALVAR, o sistema grava parâmetros que não são do leiaute (NFC-e: CID_TOKEN, COD_CSC, VERSAO_QRCODE)
    if (closed && cur && !FIELD.exec(name)) { cur.unknown.push({ line, field: name }); return; }
    if (!cur || closed) {
      const after = cur && closed;
      newNote(line);
      closed = false;
      if (after) cur!.problems.push(tx2Problem(line, 'Campos depois do SALVAR sem INCLUIR', 'Há campos depois do SALVAR da nota anterior, sem um novo INCLUIR. Eles foram lidos como outra nota.', 'Inclua INCLUIR antes dos campos da próxima nota, ou remova as linhas que sobraram.'));
    }
    const m = FIELD.exec(name);
    if (!m) { cur!.unknown.push({ line, field: name }); return; }
    cur!.fields.push({
      line, field: name, tag: m[2], id: m[3] + m[4] + m[5], letters: m[3], idNum: +m[4], idSuf: m[5], idx: m[6] ? +m[6] : undefined,
      part: part ? { ...part } : undefined, value, item,
    });
    cur!.endLine = line;
  });
  if (cur && item !== undefined) cur.problems.push(tx2Problem(cur.endLine, 'Item sem SALVARITEM', `O item ${item} não foi fechado com SALVARITEM.`, 'Inclua SALVARITEM no fim do bloco do item.'));
  if (cur && !closed) {
    cur.incomplete = true;
    cur.problems.unshift(tx2Problem(cur.endLine, 'TX2 incompleto: o arquivo termina sem SALVAR', `A nota começa na linha ${cur.startLine} e o arquivo acaba na linha ${cur.endLine} sem o SALVAR. O arquivo foi cortado ou ainda estava sendo gravado; os erros de grupos que faltam abaixo são consequência disso.`, 'Gere o TX2 de novo pelo sistema. Se ele sempre sai cortado no mesmo ponto, o problema está no dado do campo seguinte (cadastro) ou na rotina de geração.'));
  }
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
  /** ID do leiaute usado neste TX2 para cada caminho (ex.: .../ICMS51/pRedBC -> N14) */
  idsByPath: Map<string, string>;
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
    // autXML aparece com a numeração antiga do leiaute (G50-G52) em alguns geradores de TX2
    const g = f.letters === 'G' && f.idNum >= 50 ? 'autXML' : GROUP[f.letters];
    const pool = (f.tag === 'Id' || f.tag === 'versao' || f.tag === 'nItem') ? dict.byName.get('@' + f.tag) ?? [] : [...(dict.byName.get(f.tag) ?? []), ...(dict.byName.get('@' + f.tag) ?? [])];
    let c = pool.filter((n) => n.path.startsWith(infPath + '/') || n.path.startsWith(infPath + '/@'));
    if (g !== undefined) {
      const pre = g ? `${infPath}/${g}/` : `${infPath}/`;
      const inGroup = c.filter((n) => n.path.startsWith(pre) || (!!g && n.path === `${infPath}/${g}/@${f.tag}`));
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
  const trimmed: Tx2Field[] = [];
  for (const f0 of note.fields) {
    // o componente de emissão remove espaços no início e no fim dos valores (visto comparando TX2 com o XML autorizado)
    const f = { ...f0, value: f0.value.trim() };
    if (f.value !== f0.value && f.value !== '') trimmed.push(f0);
    const isItem = ITEM_LETTERS.test(f.letters);
    if (isItem && f.item === undefined) {
      problems.push({ sev: 'erro', origin: 'estrutura', title: `Campo de item fora de INCLUIRITEM: ${f.field}`, message: 'Campos dos grupos de produto e impostos precisam estar entre INCLUIRITEM e SALVARITEM.', line: f.line, tx2Field: f.field, fix: { text: 'Mova a linha para dentro do bloco do item.' } });
      continue;
    }
    const cands = candidates(f);
    if (!cands.length) { ignored.push({ line: f.line, field: f.field }); continue; }
    // campo vazio: o componente omite a tag, a não ser que o leiaute aceite vazio (ex.: cBenef vazio sai <cBenef></cBenef>)
    if (f.value === '' && !(cands.length === 1 && cands[0].f && valueOk('', cands[0].f))) { empties.push({ f, cands }); continue; }
    const key = isItem ? 'item' + f.item : 'nota';
    if (!scopes.has(key)) scopes.set(key, []);
    scopes.get(key)!.push({ f, cands });
  }

  // --- escolha de ramos (xs:choice) por escopo ---
  for (const [, placed] of scopes) resolveChoices(placed, dict);

  // --- grupos que se repetem sem índice no TX2 ---
  // dup: nDup_Y08 / dVenc_Y09 / vDup_Y10 repetidos em sequência = uma duplicata por bloco
  // autXML: CNPJ_G51_1 e CPF_G52_1 = dois autorizados (o grupo só aceita um dos dois)
  const nearestRepOf = (dn: DNode): DNode | undefined => {
    let r: DNode | undefined;
    for (let c: DNode | undefined = dn; c && c.path !== infPath; c = c.parent) if (!r && maxOf(c) > 1 && c.path !== infPath + '/det') r = c;
    return r;
  };
  const singleChoice = (n: DNode) => n.c?.length === 1 && !!(n.c[0] as Group).ch && (n.c[0] as Group).ch!.every((x) => (x as DNode).n !== undefined && !(x as DNode).c?.length);
  for (const [, placed] of scopes) {
    const state = new Map<string, { inst: number; seen: Set<string> }>();
    const choiceCount = new Map<string, number>();
    const ordered = [...placed].sort((a, b) => a.f.line - b.f.line);
    const choiceFields = ordered.filter((p) => { const r = nearestRepOf(p.cands[0]); return r && singleChoice(r) && !p.f.part; }).sort((a, b) => cmpId(a.f, b.f) || a.f.line - b.f.line);
    for (const p of choiceFields) {
      const r = nearestRepOf(p.cands[0])!;
      const n = (choiceCount.get(r.path) ?? 0) + 1;
      choiceCount.set(r.path, n);
      p.f.idx = n;
    }
    for (const p of ordered) {
      const r = nearestRepOf(p.cands[0]);
      if (!r || singleChoice(r) || p.f.idx !== undefined || p.f.part) continue;
      const st = state.get(r.path) ?? { inst: 1, seen: new Set<string>() };
      if (st.seen.has(p.cands[0].path)) { st.inst++; st.seen = new Set(); }
      st.seen.add(p.cands[0].path);
      state.set(r.path, st);
      if (st.inst > 1) p.f.idx = st.inst;
    }
  }
  if (trimmed.length) {
    problems.push({
      sev: 'info', origin: 'estrutura',
      title: `Espaço no início ou no fim de ${trimmed.length} campo${trimmed.length > 1 ? 's' : ''}`,
      message: `${trimmed.slice(0, 6).map((t) => t.field).join(', ')}${trimmed.length > 6 ? '...' : ''}. O componente de emissão remove esses espaços ao gerar o XML, então não causam rejeição; o validador também desconsidera.`,
      line: trimmed[0].line, tx2Field: trimmed[0].field,
    });
  }
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

  const idsByPath = new Map<string, string>();
  for (const [, placed] of scopes) for (const p of placed) if (!idsByPath.has(p.cands[0].path)) idsByPath.set(p.cands[0].path, p.f.id);
  for (const e of empties) if (e.cands.length === 1 && !idsByPath.has(e.cands[0].path)) idsByPath.set(e.cands[0].path, e.f.id);

  return { root, ignored, empties, problems, idGenerated, idsByPath };
}

/**
 * Decide os ramos de xs:choice (ex.: ICMS00 x ICMS51, IPITrib x IPINT, PISAliq x PISNT)
 * usando os campos com lista de valores (CST/CSOSN) como discriminadores,
 * e depois desfaz ambiguidades restantes pela ordem dos IDs do leiaute.
 */
function resolveChoices(placed: Placed[], dict: Dict) {
  // a escolha (xs:choice) é decidida por repetição: refNF no _1 e refNFP no _2 são grupos diferentes
  const inst = (p: Placed) => `${p.f.idx ?? ''}|${p.f.part ? p.f.part.name + p.f.part.n : ''}`;
  const gid = new Map<Group, number>();
  const key = (g: Group, p: Placed) => { if (!gid.has(g)) gid.set(g, gid.size); return gid.get(g) + '#' + inst(p); };
  const score = new Map<string, Map<number, number>>();
  const add = (k: string, i: number, v: number) => {
    if (!score.has(k)) score.set(k, new Map());
    const m = score.get(k)!;
    m.set(i, (m.get(i) ?? 0) + v);
  };
  for (const p of placed) {
    for (const c of p.cands) {
      const brs = dict.branchesUpTo(c, dict.root);
      const enumHit = c.f?.e ? (c.f.e.includes(p.f.value) ? 10 : -10) : 0;
      for (const b of brs) add(key(b.choice, p), b.index, 1 + enumHit);
    }
  }
  // desempate: o ramo cujos campos obrigatórios estão todos presentes (ex.: refNF x refNFP, que exige IE)
  const present = new Map<string, Set<string>>();
  for (const p of placed) {
    const k = inst(p);
    if (!present.has(k)) present.set(k, new Set());
    for (const c of p.cands) present.get(k)!.add(c.path);
  }
  for (const [k, m] of score) {
    const [gi, ik] = [+k.split('#')[0], k.slice(k.indexOf('#') + 1)];
    const g = [...gid.entries()].find(([, v]) => v === gi)?.[0];
    if (!g?.ch) continue;
    for (const i of m.keys()) {
      const br = g.ch[i] as DNode;
      if (br?.n === undefined) continue;
      const req = br.c?.length ? requiredLeaves(dict, br) : [br];
      if (!req.length) continue;
      const have = req.filter((r) => present.get(ik)?.has(r.path)).length;
      m.set(i, m.get(i)! + 5 * (have / req.length));
    }
  }
  const chosen = new Map<string, number>();
  for (const [k, m] of score) {
    let best = -Infinity, bi = 0;
    for (const [i, v] of m) if (v > best) { best = v; bi = i; }
    chosen.set(k, bi);
  }
  for (const p of placed) {
    const ok = p.cands.filter((c) => dict.branchesUpTo(c, dict.root).every((b) => chosen.get(key(b.choice, p)) === b.index));
    if (ok.length) p.cands = ok;
  }
  // nomes repetidos no mesmo grupo (UF da transportadora, do veículo e do reboque...): resolve na ordem
  // dos IDs do leiaute, usando o último campo já resolvido como limite inferior e a próxima âncora como superior
  const groups = new Map<string, Placed[]>();
  for (const p of placed) {
    const k = p.f.letters + '|' + inst(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => cmpId(a.f, b.f));
    let last = -Infinity;
    list.forEach((p, i) => {
      if (p.cands.length > 1) {
        const next = list.slice(i + 1).find((q) => q.cands.length === 1);
        const hi = next?.cands[0].o ?? Infinity;
        const after = p.cands.filter((c) => c.o > last && c.o < hi).sort((a, b) => a.o - b.o);
        p.cands = after.length ? after : [...p.cands].sort((a, b) => a.o - b.o);
      }
      last = Math.max(last, p.cands[0].o);
    });
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

/* ------------------------------------------------------------------ */
/* Tag que falta, mostrada como linha de TX2                           */
/* ------------------------------------------------------------------ */

/** IDs do leiaute (MOC) dos campos que mais faltam, para quando o próprio TX2 não traz o campo. */
const KNOWN_IDS: [string, string][] = [
  ['ide/cUF', 'B02'], ['ide/cNF', 'B03'], ['ide/natOp', 'B04'], ['ide/mod', 'B06'], ['ide/serie', 'B07'], ['ide/nNF', 'B08'],
  ['ide/dhEmi', 'B09'], ['ide/dhSaiEnt', 'B10'], ['ide/tpNF', 'B11'], ['ide/idDest', 'B11a'], ['ide/cMunFG', 'B12'], ['ide/tpImp', 'B21'],
  ['ide/tpEmis', 'B22'], ['ide/cDV', 'B23'], ['ide/tpAmb', 'B24'], ['ide/finNFe', 'B25'], ['ide/indFinal', 'B25a'], ['ide/indPres', 'B25b'],
  ['ide/indIntermed', 'B25c'], ['ide/procEmi', 'B26'], ['ide/verProc', 'B27'],
  ['emit/CNPJ', 'C02'], ['emit/CPF', 'C02a'], ['emit/xNome', 'C03'], ['emit/xFant', 'C04'], ['emit/xLgr', 'C06'], ['emit/nro', 'C07'],
  ['emit/xCpl', 'C08'], ['emit/xBairro', 'C09'], ['emit/cMun', 'C10'], ['emit/xMun', 'C11'], ['emit/UF', 'C12'], ['emit/CEP', 'C13'],
  ['emit/cPais', 'C14'], ['emit/xPais', 'C15'], ['emit/fone', 'C16'], ['emit/IE', 'C17'], ['emit/IEST', 'C18'], ['emit/IM', 'C19'], ['emit/CRT', 'C21'],
  ['dest/CNPJ', 'E02'], ['dest/CPF', 'E03'], ['dest/idEstrangeiro', 'E03a'], ['dest/xNome', 'E04'], ['dest/xLgr', 'E06'], ['dest/nro', 'E07'],
  ['dest/xCpl', 'E08'], ['dest/xBairro', 'E09'], ['dest/cMun', 'E10'], ['dest/xMun', 'E11'], ['dest/UF', 'E12'], ['dest/CEP', 'E13'],
  ['dest/cPais', 'E14'], ['dest/xPais', 'E15'], ['dest/fone', 'E16'], ['dest/indIEDest', 'E16a'], ['dest/IE', 'E17'], ['dest/email', 'E19'],
  ['prod/cProd', 'I02'], ['prod/cEAN', 'I03'], ['prod/xProd', 'I04'], ['prod/NCM', 'I05'], ['prod/CEST', 'I05c'], ['prod/cBenef', 'I05f'],
  ['prod/EXTIPI', 'I06'], ['prod/CFOP', 'I08'], ['prod/uCom', 'I09'], ['prod/qCom', 'I10'], ['prod/vUnCom', 'I10a'], ['prod/vProd', 'I11'],
  ['prod/cEANTrib', 'I12'], ['prod/uTrib', 'I13'], ['prod/qTrib', 'I14'], ['prod/vUnTrib', 'I14a'], ['prod/vFrete', 'I15'], ['prod/vSeg', 'I16'],
  ['prod/vDesc', 'I17'], ['prod/vOutro', 'I17a'], ['prod/indTot', 'I17b'],
  ['ICMS/orig', 'N11'], ['ICMS/CST', 'N12'], ['ICMS/CSOSN', 'N12a'], ['ICMS/modBC', 'N13'], ['ICMS/pRedBC', 'N14'], ['ICMS/vBC', 'N15'],
  ['ICMS/pICMS', 'N16'], ['ICMS/vICMSOp', 'N16a'], ['ICMS/pDif', 'N16b'], ['ICMS/vICMSDif', 'N16c'], ['ICMS/vICMS', 'N17'],
  ['ICMS/vBCFCP', 'N17a'], ['ICMS/pFCP', 'N17b'], ['ICMS/vFCP', 'N17c'], ['ICMS/modBCST', 'N18'], ['ICMS/pMVAST', 'N19'], ['ICMS/pRedBCST', 'N20'],
  ['ICMS/vBCST', 'N21'], ['ICMS/pICMSST', 'N22'], ['ICMS/vICMSST', 'N23'], ['ICMS/motDesICMS', 'N28'], ['ICMS/vICMSDeson', 'N28a'],
  ['IPI/cEnq', 'O06'], ['IPI/CST', 'O09'], ['IPI/vBC', 'O10'], ['IPI/pIPI', 'O13'], ['IPI/vIPI', 'O14'],
  ['PIS/CST', 'Q06'], ['PIS/vBC', 'Q07'], ['PIS/pPIS', 'Q08'], ['PIS/vPIS', 'Q09'],
  ['COFINS/CST', 'S06'], ['COFINS/vBC', 'S07'], ['COFINS/pCOFINS', 'S08'], ['COFINS/vCOFINS', 'S11'],
  ['IBSCBS/CST', 'UB13'], ['IBSCBS/cClassTrib', 'UB14'], ['gIBSCBS/vBC', 'UB16'], ['gIBSUF/pIBSUF', 'UB18'],
  ['gIBSUF/gRed/pRedAliq', 'UB27'], ['gIBSUF/gRed/pAliqEfet', 'UB28'], ['gIBSUF/vIBSUF', 'UB35'], ['gIBSMun/pIBSMun', 'UB37'],
  ['gIBSMun/gRed/pRedAliq', 'UB46'], ['gIBSMun/gRed/pAliqEfet', 'UB47'], ['gIBSMun/vIBSMun', 'UB54'], ['gIBSCBS/vIBS', 'UB54a'],
  ['gCBS/pCBS', 'UB56'], ['gCBS/gRed/pRedAliq', 'UB65'], ['gCBS/gRed/pAliqEfet', 'UB66'], ['gCBS/vCBS', 'UB67'],
  ['gTribRegular/CSTReg', 'UB69'], ['gTribRegular/cClassTribReg', 'UB70'],
];

function normPath(p: string): string {
  return p
    .replace(/\/ICMS\/ICMS\w+\//, '/ICMS/')
    .replace(/\/IPI\/(IPITrib|IPINT)\//, '/IPI/')
    .replace(/\/PIS\/PIS\w+\//, '/PIS/')
    .replace(/\/COFINS\/COFINS\w+\//, '/COFINS/')
    .replace(/\/emit\/enderEmit\//, '/emit/')
    .replace(/\/dest\/enderDest\//, '/dest/');
}
function idFor(path: string, learned: Map<string, string>): string | undefined {
  const l = learned.get(path);
  if (l) return l;
  // mesmo campo em outro item (det) do mesmo TX2
  for (const [p, id] of learned) if (normPath(p) === normPath(path)) return id;
  const n = normPath(path);
  let best: [string, string] | undefined;
  for (const kv of KNOWN_IDS) if (n.endsWith('/' + kv[0]) && (!best || kv[0].length > best[0].length)) best = kv;
  return best?.[1];
}

const maxLine = (n: XNode): number | undefined => {
  let m = n.children.length ? undefined : n.tx2Line;
  for (const a of n.attrs) if (a.tx2Line && (m === undefined || a.tx2Line > m)) m = a.tx2Line;
  for (const c of n.children) { const l = maxLine(c); if (l !== undefined && (m === undefined || l > m)) m = l; }
  return m;
};

/** Converte a prévia de XML em prévia de TX2: linha(s) campo_ID=valor depois da linha certa do TX2. */
export function tx2GhostFrom(g: Ghost, b: BuildResult, dict: Dict): Ghost | undefined {
  const parent = g.parent, name = g.name;
  if (!parent || !name) return undefined;
  const pPath = dictPath(parent);
  const dn = dict.get(pPath + '/' + name);
  if (!dn) return undefined;
  const value = /^<(\w+)>(.*)<\/\1>$/.exec(g.text)?.[2] ?? '…';
  // campo existe vazio no TX2: é para preencher a própria linha
  const empty = makeEmptyLookup(b)(parent, name);
  if (empty) return { afterLine: empty.line, depth: 0, text: `${empty.field}=${value}`, fill: true, format: 'tx2', name, note: g.note };
  const leaves = dn.c?.length ? requiredLeaves(dict, dn) : [dn];
  const text = leaves.map((l) => `${l.n}_${idFor(l.path, b.idsByPath) ?? '?'}=${l === dn ? value : g.values?.[l.n] ?? '…'}`).join('\n');
  const order = (n: XNode) => dict.get(dictPath(n))?.o ?? -1;
  const prev = [...parent.children].reverse().find((c) => order(c) < dn.o);
  const next = parent.children.find((c) => order(c) > dn.o);
  const afterLine = (prev && maxLine(prev)) ?? (next?.tx2Line !== undefined ? next.tx2Line - 1 : maxLine(parent));
  if (afterLine === undefined) return undefined;
  return { afterLine, depth: 0, text, group: g.group, format: 'tx2', name, note: g.note };
}
