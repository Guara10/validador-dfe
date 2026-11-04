/** Dicionário de campos gerado a partir do XSD oficial (scripts/build-schemas.mjs). */
export interface Facets {
  b?: string; // tipo base XSD
  tn?: string; // nome do tipo no leiaute
  p?: string[]; // patterns (todos se aplicam)
  e?: string[]; // enumeração
  ed?: Record<string, string>;
  mn?: number;
  mx?: number;
  len?: number;
  td?: number;
  fd?: number;
  minI?: string;
  maxI?: string;
}
export interface DNode {
  n: string;
  k: 'e' | 'a';
  o: number;
  min?: number;
  max?: string;
  d?: string;
  path: string;
  f?: Facets;
  tn?: string;
  c?: Particle[];
  a?: DNode[];
  opaque?: number;
  // preenchidos em runtime
  parent?: DNode;
  branch?: Branch; // ramo de xs:choice onde o nó está (o mais próximo)
}
export interface Group {
  s?: Particle[];
  ch?: Particle[];
  min?: number;
  max?: string;
}
export type Particle = DNode | Group;
export interface Branch {
  choice: Group;
  index: number;
}

export const isNode = (p: Particle): p is DNode => (p as DNode).n !== undefined;
export const minOf = (n: { min?: number }) => (n.min === undefined ? 1 : n.min);
export const maxOf = (n: { max?: string }) => (n.max === undefined ? 1 : n.max === 'unbounded' ? Infinity : +n.max);

export class Dict {
  root: DNode;
  byPath = new Map<string, DNode[]>();
  byName = new Map<string, DNode[]>();
  all: DNode[] = [];

  constructor(json: DNode) {
    this.root = json;
    const visit = (n: DNode, parent: DNode | undefined, branch: Branch | undefined) => {
      n.parent = parent;
      n.branch = branch;
      if (n.min === undefined) n.min = 1;
      if (n.max === undefined) n.max = '1';
      this.all.push(n);
      push(this.byPath, n.path, n);
      push(this.byName, n.n, n);
      for (const a of n.a ?? []) { a.parent = n; a.branch = branch; if (a.min === undefined) a.min = 1; this.all.push(a); push(this.byPath, a.path, a); push(this.byName, '@' + a.n, a); }
      const walkP = (p: Particle, br: Branch | undefined) => {
        if (isNode(p)) return visit(p, n, br);
        if (p.s) for (const x of p.s) walkP(x, br);
        if (p.ch) p.ch.forEach((x, i) => walkP(x, { choice: p, index: i }));
      };
      for (const p of n.c ?? []) walkP(p, undefined);
    };
    visit(json, undefined, undefined);
  }

  get(path: string): DNode | undefined {
    return this.byPath.get(path)?.[0];
  }
  getAll(path: string): DNode[] {
    return this.byPath.get(path) ?? [];
  }

  /** Filhos elementos de um nó, na ordem do XSD (achatando sequências e escolhas). */
  childElements(n: DNode): DNode[] {
    const out: DNode[] = [];
    const walk = (p: Particle) => {
      if (isNode(p)) { out.push(p); return; }
      for (const x of p.s ?? p.ch ?? []) walk(x);
    };
    for (const p of n.c ?? []) walk(p);
    return out;
  }
  isAncestor(anc: DNode, n: DNode): boolean {
    for (let c = n.parent; c; c = c.parent) if (c === anc) return true;
    return false;
  }
  /** O nó (ou algum ancestral até `limit`) está dentro de um xs:choice? Retorna a cadeia de ramos. */
  branchesUpTo(n: DNode, limit: DNode): Branch[] {
    const out: Branch[] = [];
    for (let c: DNode | undefined = n; c && c !== limit; c = c.parent) if (c.branch) out.push(c.branch);
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/* ------------------------------------------------------------------ */
/* Descrição dos formatos em português                                 */
/* ------------------------------------------------------------------ */

export function decimalShape(f: Facets): { int: number; dmin: number; dmax: number; decOptional: boolean } | null {
  const p = f.p?.find((x) => x.includes('[1-9]'));
  if (!p) return null;
  const mi = /\[1-9\]\{1\}\[0-9\]\{0,(\d+)\}/.exec(p) || /\[1-9\]\[0-9\]\{0,(\d+)\}/.exec(p);
  const md = /\\\.\[0-9\]\{(\d+)(?:,(\d+))?\}/.exec(p);
  if (!mi) return null;
  const int = +mi[1] + 1;
  if (!md) return { int, dmin: 0, dmax: 0, decOptional: true };
  return { int, dmin: +md[1], dmax: md[2] ? +md[2] : +md[1], decOptional: /\)\?\s*$/.test(p) };
}

const T_STRING = '[!-ÿ]{1}[ -ÿ]{0,}[!-ÿ]{1}|[!-ÿ]{1}';

export function describeFormat(f: Facets | undefined): string {
  if (!f) return '';
  const parts: string[] = [];
  const dec = decimalShape(f);
  if (f.e?.length) {
    const opts = f.e.map((v) => (f.ed?.[v] ? `${v} (${f.ed[v]})` : v));
    parts.push(f.e.length === 1 ? `Valor fixo: ${opts[0]}` : `Um destes valores: ${opts.join(', ')}`);
  } else if (dec) {
    const d = dec.dmax === 0 ? 'sem casas decimais' : dec.dmin === dec.dmax ? `${dec.dmin} casas decimais` : `de ${dec.dmin} a ${dec.dmax} casas decimais`;
    parts.push(`Número com ponto decimal: até ${dec.int} dígitos inteiros e ${d}${dec.decOptional && dec.dmax ? ' (decimais opcionais para inteiros)' : ''}. Sem zero à esquerda e sem separador de milhar`);
  } else if (f.tn === 'TDateTimeUTC' || /T\(20\|21/.test(f.p?.[0] ?? '')) {
    parts.push('Data e hora no formato AAAA-MM-DDThh:mm:ss±hh:00 (ex.: 2026-10-27T14:30:00-03:00)');
  } else if (f.tn === 'TData' || (f.p?.[0] ?? '').startsWith('(((20(([02468]')) {
    parts.push('Data no formato AAAA-MM-DD');
  } else if (f.p?.length) {
    for (const p of f.p) {
      if (p === T_STRING) parts.push('Texto sem espaço no início ou no fim e sem quebra de linha');
      else parts.push(describePattern(p));
    }
  }
  if (f.len !== undefined) parts.push(`exatamente ${f.len} caracteres`);
  else if (f.mn !== undefined && f.mx !== undefined) parts.push(f.mn === f.mx ? `${f.mn} caracteres` : `de ${f.mn} a ${f.mx} caracteres`);
  else if (f.mx !== undefined) parts.push(`até ${f.mx} caracteres`);
  else if (f.mn !== undefined) parts.push(`no mínimo ${f.mn} caractere${f.mn > 1 ? 's' : ''}`);
  return parts.join('; ');
}

function describePattern(p: string): string {
  const alts = p.split('|');
  const digits = alts.map((a) => {
    let m = /^\[0-9\]\{(\d+)\}$/.exec(a) || /^\\d\{(\d+)\}$/.exec(a);
    if (m) return `${m[1]}`;
    m = /^\[0-9\]\{(\d+),(\d+)\}$/.exec(a) || /^\\d\{(\d+),(\d+)\}$/.exec(a);
    if (m) return `${m[1]} a ${m[2]}`;
    return null;
  });
  if (digits.every(Boolean)) return `Somente números, com ${digits.join(' ou ')} dígitos`;
  return `Formato: ${p}`;
}

/* ------------------------------------------------------------------ */
/* Conferência e correção de valores                                   */
/* ------------------------------------------------------------------ */

const reCache = new Map<string, RegExp>();
function xsdRegex(p: string): RegExp {
  let r = reCache.get(p);
  if (!r) {
    // XSD: o pattern sempre casa o valor inteiro
    r = new RegExp('^(?:' + p.replace(/\\i|\\c/g, '.') + ')$');
    reCache.set(p, r);
  }
  return r;
}

export function valueOk(v: string, f: Facets | undefined): boolean {
  if (!f) return true;
  if (f.e && !f.e.includes(v)) return false;
  if (f.p) for (const p of f.p) { try { if (!xsdRegex(p).test(v)) return false; } catch { /* regex não suportada */ } }
  const len = [...v].length;
  if (f.len !== undefined && len !== f.len) return false;
  if (f.mn !== undefined && len < f.mn) return false;
  if (f.mx !== undefined && len > f.mx) return false;
  return true;
}

/** Tenta corrigir o valor para o formato exigido. Só retorna se o resultado passa no formato. */
/** Arredonda um número escrito em decimal (string) para d casas, meio para cima, sem passar por binário. */
export function roundDecStr(s: string, d: number): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const [ip, fp = ''] = [m[1], m[2] ?? ''];
  const digits = (ip + fp.padEnd(d + 1, '0').slice(0, d + 1)).replace(/^0+(?=\d)/, '');
  let n = BigInt(digits.slice(0, -1) || '0');
  if (+digits.slice(-1) >= 5) n += 1n;
  const str = n.toString().padStart(d + 1, '0');
  const out = d ? `${str.slice(0, -d)}.${str.slice(-d)}` : str;
  return out.replace(/^0+(?=\d)/, '');
}
const padDec = (s: string, d: number) => {
  const [i, f = ''] = s.split('.');
  return d ? `${i}.${f.padEnd(d, '0')}` : i;
};

/** Tenta corrigir o valor para o formato exigido. Só retorna se o resultado passa no formato. */
export function suggestValue(v: string, f: Facets | undefined): { value: string; how: string } | null {
  if (!f || v === '') return null;
  const tries: { value: string; how: string }[] = [];
  const dec = decimalShape(f);
  if (dec) {
    let s = v.trim();
    let how = '';
    let ok = true;
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) { s = s.replace(/\./g, '').replace(',', '.'); how = 'troquei a vírgula decimal por ponto e tirei o separador de milhar'; }
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) { s = s.replace(/,/g, ''); how = 'tirei a vírgula de milhar'; }
    else if (/^\d+,\d+$/.test(s)) { s = s.replace(',', '.'); how = 'troquei a vírgula decimal por ponto'; }
    else if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) ok = false; // "1.500.000": separador de milhar, sem decimal claro
    else if (s.includes(',')) ok = false;
    // "1.500" com 3 casas: lido como decimal (é o que os sistemas geram), mas avisa
    const ambiguo = /^\d{1,3}\.\d{3}$/.test(s) && (dec.dmax ?? 0) < 3;
    if (ok && /^0\d/.test(s)) { s = s.replace(/^0+(?=\d)/, ''); how = how ? how + ' e tirei os zeros à esquerda' : 'tirei os zeros à esquerda'; }
    if (ok && /^\d+(\.\d+)?$/.test(s)) {
      const [, d = ''] = s.split('.');
      if (dec.dmax && d.length > dec.dmax) {
        tries.push({ value: roundDecStr(s, dec.dmax), how: (how ? how + '; ' : '') + `arredondei para ${dec.dmax} casas (confira se o cálculo de origem não deveria ser ajustado)` + (ambiguo ? `. Li ${s} como número decimal; se o ponto era separador de milhar (${s.replace('.', '')}), corrija à mão` : '') });
      } else if (d.length && d.length < dec.dmin) {
        tries.push({ value: padDec(s, dec.dmin), how: (how ? how + '; ' : '') + `completei para ${dec.dmin} casas decimais` });
      } else if (dec.dmin && !d.length && !dec.decOptional) {
        tries.push({ value: padDec(s, dec.dmin), how: `incluí ${dec.dmin} casas decimais` });
      }
      tries.push({ value: s, how: how || 'ajustei o formato' });
      if (dec.dmin) tries.push({ value: d.length > dec.dmin ? roundDecStr(s, dec.dmin) : padDec(s, dec.dmin), how: (how ? how + '; ' : '') + `formatei com ${dec.dmin} casas decimais` });
    }
  }
  if (f.e) {
    const t = v.trim();
    const hit = f.e.find((e) => e === t || e === t.padStart(e.length, '0') || e.replace(/^0+/, '') === t.replace(/^0+/, ''));
    if (hit) tries.push({ value: hit, how: hit.length > t.length ? 'completei com zeros à esquerda' : 'ajustei para o código da tabela' });
  }
  // só números
  if (f.p?.some((p) => /^(\[0-9\]|\\d)\{/.test(p))) {
    const digits = v.replace(/\D/g, '');
    if (digits !== v) tries.push({ value: digits, how: 'removi pontos, traços, barras e espaços' });
  }
  // texto: caracteres fora do Latin-1 (corrompidos, travessão, aspas tipográficas...)
  if (/[^\u0020-\u00FF]/.test(v)) {
    const t = v.replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[^\u0020-\u00FF]/g, ' ').replace(/ {2,}/g, ' ').trim();
    tries.push({ value: t, how: 'removi caracteres que o leiaute não aceita' });
  }
  // texto: espaços nas pontas, quebras de linha, espaços duplos
  {
    let t = v.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (t !== v) tries.push({ value: t, how: 'removi espaços no início/fim e quebras de linha' });
    const lim = f.len ?? f.mx;
    const textoLivre = !f.e && !decimalShape(f) && (f.p ?? []).every((p) => p === T_STRING);
    if (textoLivre && lim && [...t].length > lim) tries.push({ value: [...t].slice(0, lim).join('').trim(), how: `cortei em ${lim} caracteres (confira se não perdeu informação importante)` });
  }
  for (const t of tries) if (t.value !== v && valueOk(t.value, f)) return t;
  return null;
}

/** Descreve o primeiro caractere fora do que o leiaute aceita (Latin-1 imprimível). */
export function badCharInfo(v: string): string | null {
  const chars = [...v];
  const i = chars.findIndex((c) => !/[\u0020-\u00FF]/.test(c));
  if (i < 0) return null;
  const c = chars[i];
  const code = 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
  const NAMES: Record<string, string> = {
    '\u2013': 'travessão (–)', '\u2014': 'travessão longo (—)',
    '\u201C': 'aspas tipográficas (“)', '\u201D': 'aspas tipográficas (”)',
    '\u2018': 'apóstrofo tipográfico (‘)', '\u2019': 'apóstrofo tipográfico (’)',
    '\u2022': 'marcador (•)', '\u20AC': 'símbolo do euro (€)', '\t': 'tabulação', '\u00A0': 'espaço especial',
  };
  const name = c.codePointAt(0) === 0xfffd ? 'caractere corrompido, normalmente acento ou símbolo que se perdeu numa conversão de texto' : NAMES[c] ?? (c.codePointAt(0)! < 32 ? 'caractere de controle invisível' : `caractere especial "${c}"`);
  const before = chars.slice(Math.max(0, i - 12), i).join('');
  return `Tem um ${name} (${code}) na posição ${i + 1}, logo depois de "${before}". O leiaute só aceita letras, números, acentos comuns e símbolos básicos.`;
}
