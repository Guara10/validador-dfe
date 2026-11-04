import type { Finding, XNode } from '../types';
import { Dict, describeFormat, suggestValue, valueOk, badCharInfo, type DNode, minOf, maxOf } from '../dict';
import { dictPath, humanPath } from '../xml/parse';
import { ghostFor } from '../ghost';

export interface RawXsdError {
  line: number | null;
  message: string;
}

export interface TranslateCtx {
  dict: Dict;
  /** mapa linha do XML validado -> nó */
  byLine: Map<number, XNode>;
  /** origem TX2: devolve a linha/campo de um campo vazio do TX2 que corresponderia a <name> dentro de <parent> */
  tx2Empty?: (parent: XNode, name: string) => { line: number; field: string } | undefined;
  /** origem TX2: devolve a linha do TX2 onde o grupo começa */
  tx2GroupLine?: (n: XNode) => number | undefined;
}

const NS = /\{[^}]*\}/g;
const clean = (s: string) => s.replace(NS, '');
const shortDoc = (d?: string) => (d ? (d.length > 220 ? d.slice(0, 217) + '...' : d) : undefined);

function locate(ctx: TranslateCtx, line: number | null, name: string): XNode | undefined {
  if (line == null) return undefined;
  const n = ctx.byLine.get(line);
  if (!n) return undefined;
  if (n.name === name) return n;
  // pode ser a linha de um filho/pai com o mesmo número
  const kid = n.children.find((c) => c.name === name && c.fmtLine === line);
  if (kid) return kid;
  for (let p = n.parent; p; p = p.parent) if (p.name === name) return p;
  return n;
}

function dictNodeFor(ctx: TranslateCtx, n: XNode, attrName?: string): DNode | undefined {
  const p = dictPath(n) + (attrName ? '/@' + attrName : '');
  const all = ctx.dict.getAll(p);
  return all[0];
}

/** Linha a exibir: no TX2 usa a linha do campo; no XML a linha formatada. */
function showLine(ctx: TranslateCtx, n: XNode | undefined, attrName?: string): number | undefined {
  if (!n) return undefined;
  if (ctx.tx2GroupLine) {
    if (attrName) {
      const a = n.attrs.find((x) => x.name === attrName);
      if (a?.tx2Line) return a.tx2Line;
    }
    return n.tx2Line ?? ctx.tx2GroupLine(n);
  }
  return n.fmtLine;
}
function fieldOf(n: XNode | undefined, attrName?: string): string | undefined {
  if (!n) return undefined;
  if (attrName) return n.attrs.find((a) => a.name === attrName)?.tx2Field;
  return n.tx2Field;
}

export function translateXsdErrors(raw: RawXsdError[], ctx: TranslateCtx): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const facetHit = new Set<string>();

  for (const e of raw) {
    const msg = clean(e.message).replace(/^.*?Schemas validity error\s*:\s*/, '').replace(/^element [^:]+:\s*/, '').trim();
    let m: RegExpExecArray | null;

    // ---- facetas (formato, tamanho, lista) ----
    if ((m = /^Element '([^']+)'(?:, attribute '([^']+)')?: \[facet '(\w+)'\] (.*)$/.exec(msg))) {
      const [, el, at, facet, rest] = m;
      const node = locate(ctx, e.line, el);
      const key = `${e.line}|${el}|${at ?? ''}`;
      facetHit.add(key);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(facetFinding(ctx, node, el, at, facet, rest));
      continue;
    }
    if ((m = /^Element '([^']+)'(?:, attribute '([^']+)')?: '(.*)' is not a valid value of the (?:local )?(?:atomic|list|union) type '([^']+)'\.?$/.exec(msg))) {
      const [, el, at, val] = m;
      const key = `${e.line}|${el}|${at ?? ''}`;
      if (facetHit.has(key) || seen.has(key)) continue; // já explicado pela faceta
      seen.add(key);
      const node = locate(ctx, e.line, el);
      out.push(facetFinding(ctx, node, el, at, 'type', `The value '${val}'`));
      continue;
    }

    // ---- tag inesperada ----
    if ((m = /^Element '([^']+)': This element is not expected\.(?: Expected is (?:one of )?\( (.+) \)\.)?$/.exec(msg))) {
      const [, el, exp] = m;
      const node = locate(ctx, e.line, el);
      out.push(unexpectedFinding(ctx, node, el, exp ? exp.split(/,\s*/) : []));
      continue;
    }
    // ---- falta filho ----
    if ((m = /^Element '([^']+)': Missing child element\(s\)\. Expected is (?:one of )?\( (.+) \)\.$/.exec(msg))) {
      const [, el, exp] = m;
      const node = locate(ctx, e.line, el);
      const f = missingFinding(ctx, node, el, exp.split(/,\s*/));
      if (f) out.push(f);
      continue;
    }
    // ---- atributos ----
    if ((m = /^Element '([^']+)': The attribute '([^']+)' is required but missing\.$/.exec(msg))) {
      const [, el, at] = m;
      const node = locate(ctx, e.line, el);
      const dn = node ? dictNodeFor(ctx, node, at) : undefined;
      out.push({
        sev: 'erro', origin: 'schema', code: '225',
        title: `Falta o atributo ${at} em <${el}>`,
        message: `A tag <${el}> precisa do atributo ${at}.`,
        path: node ? humanPath(node) : el, line: showLine(ctx, node), tx2Field: fieldOf(node),
        expected: describeFormat(dn?.f) || undefined,
        doc: shortDoc(dn?.d),
        fix: { text: `Inclua ${at}="..." na tag <${el}>.` },
      });
      continue;
    }
    if ((m = /^Element '([^']+)', attribute '([^']+)': The attribute '([^']+)' is not allowed\.$/.exec(msg))) {
      const [, el, at] = m;
      const node = locate(ctx, e.line, el);
      out.push({
        sev: 'erro', origin: 'schema', code: '225',
        title: `Atributo ${at} não é permitido em <${el}>`,
        message: `O leiaute não prevê o atributo ${at} nessa tag.`,
        path: node ? humanPath(node) : el, line: showLine(ctx, node, at),
        fix: { text: `Remova o atributo ${at}.` },
      });
      continue;
    }
    if ((m = /^Element '([^']+)': Character content other than whitespace is not allowed because the content type is 'element-only'\.$/.exec(msg))) {
      const [, el] = m;
      const node = locate(ctx, e.line, el);
      out.push({
        sev: 'erro', origin: 'schema', code: '225',
        title: `Texto solto dentro do grupo <${el}>`,
        message: `<${el}> é um grupo: só pode conter outras tags, não texto direto.`,
        path: node ? humanPath(node) : el, line: showLine(ctx, node),
        fix: { text: 'Remova o texto que está entre as tags desse grupo (pode ser um valor que deveria estar dentro de uma tag filha).' },
      });
      continue;
    }
    if ((m = /^Element '([^']+)': Element content is not allowed, because the content type is a simple type definition\.$/.exec(msg))) {
      const [, el] = m;
      const node = locate(ctx, e.line, el);
      out.push({
        sev: 'erro', origin: 'schema', code: '225',
        title: `Tag dentro de um campo simples <${el}>`,
        message: `<${el}> é um campo de valor e não pode conter outras tags.`,
        path: node ? humanPath(node) : el, line: showLine(ctx, node),
        fix: { text: `Feche <${el}> antes de abrir a próxima tag.` },
      });
      continue;
    }
    if ((m = /^Element '([^']+)': Duplicate key-sequence \[(.+)\] in unique identity-constraint '([^']+)'\.$/.exec(msg))) {
      const [, el, val] = m;
      const node = locate(ctx, e.line, el);
      out.push({
        sev: 'erro', origin: 'schema', code: '225',
        title: el === 'det' ? `Número de item repetido (nItem ${val.replace(/'/g, '')})` : `Valor repetido em <${el}>`,
        message: el === 'det' ? 'Dois itens da nota têm o mesmo nItem. Cada item precisa de um número único e sequencial.' : `O valor ${val} aparece mais de uma vez onde precisa ser único.`,
        path: node ? humanPath(node) : el, line: showLine(ctx, node),
        found: val.replace(/'/g, ''),
        fix: { text: 'Renumere os itens em sequência (1, 2, 3...).' },
      });
      continue;
    }
    if ((m = /^Element '([^']+)': No matching global declaration available for the validation root\.$/.exec(msg))) {
      const [, el] = m;
      out.push({
        sev: 'erro', origin: 'schema', code: '225',
        title: 'O arquivo não é reconhecido como NF-e',
        message: `A tag raiz <${el}> não corresponde ao leiaute da NF-e 4.00 (esperado <NFe>, <nfeProc> ou <enviNFe> no namespace http://www.portalfiscal.inf.br/nfe).`,
        line: 1,
        fix: { text: 'Confira se a tag raiz tem xmlns="http://www.portalfiscal.inf.br/nfe" e se o arquivo é mesmo de NF-e/NFC-e (modelo 55 ou 65).' },
      });
      continue;
    }

    // ---- não reconhecido: mostra cru ----
    const node = e.line != null ? ctx.byLine.get(e.line) : undefined;
    out.push({
      sev: 'erro', origin: 'schema', code: '225',
      title: 'Falha de schema',
      message: msg,
      path: node ? humanPath(node) : undefined,
      line: showLine(ctx, node),
    });
  }
  return out;
}

function facetFinding(ctx: TranslateCtx, node: XNode | undefined, el: string, at: string | undefined, facet: string, rest: string): Finding {
  const dn = node ? dictNodeFor(ctx, node, at) : undefined;
  const value = at ? node?.attrs.find((a) => a.name === at)?.value ?? '' : node?.text ?? '';
  const label = at ? `${el}/@${at}` : el;
  const fmt = describeFormat(dn?.f);
  const base: Finding = {
    sev: 'erro', origin: 'schema', code: '225',
    title: '', message: '',
    path: node ? humanPath(node) + (at ? ' / @' + at : '') : label,
    line: showLine(ctx, node, at), tx2Field: fieldOf(node, at),
    found: value === '' ? '(vazio)' : value,
    expected: fmt || undefined,
    doc: shortDoc(dn?.d),
  };

  if (value === '' || /^\s+$/.test(value)) {
    const required = dn ? minOf(dn) > 0 : true;
    const parent = dn?.parent;
    const parentOptional = parent && (minOf(parent) === 0 || parent.branch);
    base.title = `Campo ${label} vazio`;
    base.message = value === '' ? `A tag <${el}> foi gerada sem conteúdo, e o schema não aceita tag vazia.` : `<${el}> contém só espaços.`;
    if (!required) base.fix = { text: `${el} é opcional: quando não houver valor, não gere a tag.` };
    else if (parentOptional && parent) base.fix = { text: `${el} é obrigatório dentro de <${parent.n}>. Preencha o campo ou, se a operação não usa o grupo <${parent.n}>, não gere o grupo inteiro.` };
    else base.fix = { text: `${el} é obrigatório: precisa ter valor.` };
    return base;
  }

  let sug = suggestValue(value, dn?.f);
  // cListServ (LC 116, NN.NN) preenchido com o código de tributação nacional da NFS-e (6 dígitos)
  if (!sug && el === 'cListServ' && /^\d{6}$/.test(value)) sug = { value: `${value.slice(0, 2)}.${value.slice(2, 4)}`, how: `${value} é o código de tributação nacional (cTribNac) da NFS-e; o cListServ usa o item da LC 116 no formato NN.NN, que são os 4 primeiros dígitos` };
  switch (facet) {
    case 'enumeration': {
      base.title = `Código não aceito em ${label}`;
      base.message = `O valor "${value}" não está na lista de códigos permitidos para este campo.`;
      break;
    }
    case 'maxLength': {
      const lim = /maximum length of '(\d+)'/.exec(rest)?.[1];
      base.title = `${label} maior que o permitido`;
      base.message = `O conteúdo tem ${[...value].length} caracteres; o máximo é ${lim}.`;
      break;
    }
    case 'minLength': {
      const lim = /minimum length of '(\d+)'/.exec(rest)?.[1];
      base.title = `${label} menor que o permitido`;
      base.message = `O conteúdo tem ${[...value].length} caracteres; o mínimo é ${lim}.`;
      break;
    }
    case 'length': {
      const lim = /allowed length of '(\d+)'/.exec(rest)?.[1];
      base.title = `${label} com tamanho errado`;
      base.message = `O conteúdo tem ${[...value].length} caracteres; precisam ser exatamente ${lim}.`;
      break;
    }
    default: {
      base.title = `${label} fora do formato`;
      base.message = explainPattern(value, dn);
    }
  }
  base.fix = sug
    ? { text: `Valor corrigido (${sug.how}).`, value: sug.value }
    : { text: fmt ? `Ajuste o valor para o formato: ${fmt}.` : 'Ajuste o valor conforme o leiaute.' };
  return base;
}

/** Diagnóstico específico de alguns padrões comuns. */
function explainPattern(v: string, dn?: DNode): string {
  const bad = badCharInfo(v);
  if (bad) return bad + ' Geralmente vem do cadastro (texto colado de outro programa); corrija lá para não voltar na próxima nota.';
  if (/^\s|\s$/.test(v)) return 'O valor tem espaço no início ou no fim, e o leiaute não aceita.';
  if (/[\r\n\t]/.test(v)) return 'O valor tem quebra de linha ou tabulação, e o leiaute não aceita.';
  if (dn?.f?.p?.some((p) => p.includes('[1-9]')) && v.includes(',')) return 'Número com vírgula: o XML usa ponto como separador decimal.';
  if (dn?.f?.p?.some((p) => p.includes('[1-9]')) && /^0\d/.test(v)) return 'Número com zero à esquerda: o leiaute não aceita.';
  if (dn?.f?.p?.some((p) => p.includes('[1-9]')) && /^-/.test(v)) return 'Número negativo: o leiaute não aceita valores negativos neste campo.';
  const digitPat = dn?.f?.p?.find((p) => /^(\[0-9\]|\\d)\{\d+(,\d+)?\}(\|(\[0-9\]|\\d)\{\d+(,\d+)?\})*$/.test(p));
  if (digitPat) {
    const nd = v.replace(/\D/g, '').length;
    if (/\D/.test(v)) return 'O campo aceita só números, sem pontos, traços ou barras.';
    return `O valor tem ${nd} dígitos, que não é uma quantidade aceita.`;
  }
  if (dn?.f?.tn === 'TDateTimeUTC') return 'Data/hora fora do formato AAAA-MM-DDThh:mm:ss±hh:00 (o fuso é obrigatório).';
  return 'O valor não segue o formato exigido pelo leiaute.';
}

function nameInfo(ctx: TranslateCtx, parent: XNode | undefined, name: string): DNode | undefined {
  if (!parent) return undefined;
  return ctx.dict.get(dictPath(parent) + '/' + name);
}

function unexpectedFinding(ctx: TranslateCtx, node: XNode | undefined, el: string, expected: string[]): Finding {
  const parent = node?.parent;
  const pPath = parent ? dictPath(parent) : '';
  const pDict = ctx.dict.get(pPath);
  const allowed = pDict ? ctx.dict.childElements(pDict) : [];
  const isChild = allowed.some((c) => c.n === el);
  const presentNames = new Set(parent?.children.map((c) => c.name));
  const exp = expected.filter((x) => !x.startsWith('##'));
  const base: Finding = {
    sev: 'erro', origin: 'schema', code: '225', title: '', message: '',
    path: node ? humanPath(node) : el, line: showLine(ctx, node), tx2Field: fieldOf(node),
  };

  // faltou um obrigatório antes
  const missingReq = exp.filter((x) => !presentNames.has(x) && (nameInfo(ctx, parent, x)?.min ?? 1) > 0);
  if (isChild && missingReq.length) {
    const x = missingReq[0];
    const xd = nameInfo(ctx, parent, x);
    const empty = parent && ctx.tx2Empty?.(parent, x);
    base.title = `Falta ${missingReq.length > 1 ? 'uma destas tags' : 'a tag'} <${missingReq.join('>, <')}> em <${parent?.name}>`;
    base.message = `O schema esperava <${missingReq.join('> ou <')}> antes de <${el}>.` + (empty ? ` No TX2, ${empty.field} (linha ${empty.line}) está vazio, então a tag não foi gerada.` : '');
    base.doc = shortDoc(xd?.d);
    base.expected = describeFormat(xd?.f) || undefined;
    if (empty) base.line = empty.line, base.tx2Field = empty.field;
    base.fix = { text: grpFix(x, xd) };
    const g = ghostFor(ctx.dict, parent, x);
    if (g) base.ghosts = [g];
    return base;
  }
  if (!isChild) {
    const where = (ctx.dict.byName.get(el) ?? []).map((d) => d.path.replace(/^NFe\/infNFe\//, '').replace(/\//g, ' / ')).slice(0, 3);
    base.title = `<${el}> não pertence ao grupo <${parent?.name ?? '?'}>`;
    base.message = where.length
      ? `Essa tag existe no leiaute, mas em outro lugar: ${where.join('; ')}.`
      : `Essa tag não existe no leiaute da NF-e 4.00 (erro de digitação ou campo de outra versão?).`;
    base.fix = { text: where.length ? 'Mova a tag para o grupo correto.' : 'Remova a tag ou corrija o nome.' };
    return base;
  }
  // repetição além do permitido
  const dn = nameInfo(ctx, parent, el);
  const count = parent?.children.filter((c) => c.name === el).length ?? 0;
  if (dn && count > maxOf(dn)) {
    base.title = `<${el}> repetida em <${parent?.name}>`;
    base.message = `Essa tag pode aparecer no máximo ${maxOf(dn)} vez(es) dentro de <${parent?.name}>, e aparece ${count}.`;
    base.fix = { text: 'Remova a repetição.' };
    return base;
  }
  // grupo de escolha com dois ramos (ex.: dois grupos ICMS)
  if (dn?.branch && parent && parent.children.filter((c) => nameInfo(ctx, parent, c.name)?.branch?.choice === dn.branch!.choice).length > 1) {
    const ramos = parent.children.filter((c) => nameInfo(ctx, parent, c.name)?.branch?.choice === dn.branch!.choice).map((c) => c.name);
    base.title = `Só um destes grupos pode existir em <${parent.name}>`;
    base.message = `Foram informados ${ramos.map((r) => '<' + r + '>').join(' e ')}, mas o leiaute aceita apenas um.`;
    base.fix = { text: 'Mantenha só o grupo correspondente ao CST/situação da operação.' };
    return base;
  }
  // fora de ordem
  const idx = (n: string) => allowed.findIndex((a) => a.n === n);
  const prevSib = node && parent ? parent.children[parent.children.indexOf(node) - 1] : undefined;
  base.title = `<${el}> fora de ordem em <${parent?.name}>`;
  base.message = prevSib && idx(prevSib.name) > idx(el)
    ? `<${el}> deveria vir antes de <${prevSib.name}>. O leiaute exige uma ordem fixa das tags.`
    : `Neste ponto o schema esperava <${exp.join('> ou <') || '?'}>. O leiaute exige uma ordem fixa das tags.`;
  base.fix = { text: `Ordem correta em <${parent?.name}>: ${allowed.map((a) => a.n).filter((n, i, a) => a.indexOf(n) === i).slice(0, 25).join(', ')}${allowed.length > 25 ? '...' : ''}` };
  return base;
}

function grpFix(x: string, xd?: DNode): string {
  const parent = xd?.parent;
  const parentOptional = parent && (minOf(parent) === 0 || parent.branch);
  if (parentOptional && parent) return `Preencha ${x}${xd?.d ? ` (${shortDoc(xd.d)})` : ''}. Se a operação não usa o grupo <${parent.n}>, o grupo inteiro não deve ser gerado.`;
  return `Preencha ${x}${xd?.d ? ` (${shortDoc(xd.d)})` : ''}.`;
}

function missingFinding(ctx: TranslateCtx, node: XNode | undefined, el: string, expected: string[]): Finding | null {
  const exp = expected.filter((x) => !x.startsWith('##'));
  // NF-e ainda não assinada: normal antes da transmissão
  if (el === 'NFe' && exp.includes('Signature')) {
    return {
      sev: 'info', origin: 'schema',
      title: 'XML sem assinatura digital',
      message: 'A tag <Signature> não está no arquivo. É normal em XML gerado antes da transmissão; a assinatura é colocada no envio.',
      path: 'NFe', line: showLine(ctx, node),
    };
  }
  const empty = node && exp.map((x) => ctx.tx2Empty?.(node, x)).find(Boolean);
  const xd = nameInfo(ctx, node, exp[0]);
  return {
    sev: 'erro', origin: 'schema', code: '225',
    title: `Falta ${exp.length > 1 ? 'uma destas tags' : 'a tag'} <${exp.join('>, <')}> em <${el}>`,
    message: `O grupo <${el}> termina sem ${exp.length > 1 ? 'nenhuma das tags esperadas' : `<${exp[0]}>, que é obrigatória`}.` + (empty ? ` No TX2, ${empty.field} (linha ${empty.line}) está vazio, então a tag não foi gerada.` : ''),
    path: node ? humanPath(node) : el,
    line: empty?.line ?? showLine(ctx, node), tx2Field: empty?.field ?? fieldOf(node),
    doc: shortDoc(xd?.d),
    expected: describeFormat(xd?.f) || undefined,
    fix: { text: grpFix(exp[0], xd) },
    ghosts: ((g) => (g ? [g] : undefined))(ghostFor(ctx.dict, node, exp[0])),
  };
}

/**
 * O libxml2 para de validar um grupo no primeiro erro de estrutura (igual à SEFAZ).
 * Esta varredura confere todos os campos de valor e todas as tags contra o dicionário,
 * para mostrar de uma vez os problemas que ficariam escondidos atrás do primeiro.
 */
export function sweepTree(root: XNode, ctx: TranslateCtx, already: Finding[]): Finding[] {
  const out: Finding[] = [];
  const reported = new Set(already.map((f) => `${f.line}|${f.path}`));
  const has = (n: XNode, at?: string) => reported.has(`${showLine(ctx, n, at)}|${humanPath(n) + (at ? ' / @' + at : '')}`) || already.some((f) => f.line === showLine(ctx, n, at) && f.title.includes(at ?? n.name));
  const walk = (n: XNode) => {
    if (n.opaque !== undefined) return;
    const path = dictPath(n);
    const cands = ctx.dict.getAll(path);
    if (!cands.length) return; // fora do NFe (protNFe etc.) ou já acusado como tag desconhecida
    // filhos que não existem no grupo
    const allowed = new Set(cands.flatMap((c) => ctx.dict.childElements(c).map((x) => x.n)));
    if (cands.some((c) => c.c)) {
      for (const k of n.children) {
        if (!allowed.has(k.name) && !has(k)) {
          const where = (ctx.dict.byName.get(k.name) ?? []).map((d) => d.path.replace(/^NFe\/infNFe\//, '').replace(/\//g, ' / ')).slice(0, 3);
          out.push({
            sev: 'erro', origin: 'schema', code: '225',
            title: `<${k.name}> não pertence ao grupo <${n.name}>`,
            message: where.length ? `Essa tag existe no leiaute, mas em outro lugar: ${where.join('; ')}.` : 'Essa tag não existe no leiaute da NF-e 4.00 (erro de digitação ou campo de outra versão?).',
            path: humanPath(k), line: showLine(ctx, k), tx2Field: fieldOf(k),
            fix: { text: where.length ? 'Mova a tag para o grupo correto.' : 'Remova a tag ou corrija o nome.' },
          });
        }
      }
    }
    // atributos
    for (const a of n.attrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
      const ac = ctx.dict.getAll(path + '/@' + a.name);
      if (ac.length && !ac.some((c) => valueOk(a.value, c.f)) && !has(n, a.name)) out.push(sweepFacet(ctx, n, a.name, ac[0], a.value));
    }
    // valor de folha
    if (!n.children.length && !cands.some((c) => c.c)) {
      const v = n.text ?? '';
      if (!cands.some((c) => valueOk(v, c.f)) && !has(n)) out.push(sweepFacet(ctx, n, undefined, cands[0], v));
    }
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

function sweepFacet(ctx: TranslateCtx, n: XNode, at: string | undefined, dn: DNode, v: string): Finding {
  const f = dn.f ?? {};
  const len = [...v].length;
  let facet = 'pattern';
  let rest = '';
  if (v !== '' && f.e && !f.e.includes(v)) facet = 'enumeration';
  else if (v !== '' && f.mx !== undefined && len > f.mx) { facet = 'maxLength'; rest = `maximum length of '${f.mx}'`; }
  else if (v !== '' && f.mn !== undefined && len < f.mn) { facet = 'minLength'; rest = `minimum length of '${f.mn}'`; }
  else if (v !== '' && f.len !== undefined && len !== f.len) { facet = 'length'; rest = `allowed length of '${f.len}'`; }
  return facetFinding(ctx, n, n.name, at, facet, rest);
}
