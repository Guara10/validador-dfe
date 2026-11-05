import type { Finding, XNode, DocSummary } from '../types';
import { attr, child, childrenNamed, select, humanPath } from '../xml/parse';
import type { Dict } from '../dict';
import { ghostFor } from '../ghost';

/**
 * Regras de conferência da NF-e que não dependem de opinião fiscal:
 *  - contas (valor = base x alíquota, totais = soma dos itens)
 *  - coerência entre campos (chave x campos da ide, CFOP x tipo de operação)
 *  - avisos de plausibilidade (fuso horário, peso, duplicatas)
 * Nunca sugere alíquota, CST ou CFOP "certos": só aponta o que não fecha.
 */

export interface RuleCtx {
  lineOf: (n: XNode | undefined) => number | undefined;
  fieldOf: (n: XNode | undefined) => string | undefined;
  /** momento da validação (injetável nos testes) */
  now?: Date;
  /** nota já autorizada (nfeProc com protocolo): regras de prazo de envio não se aplicam */
  autorizada?: boolean;
  /** dicionário do leiaute, para mostrar onde entra a tag que falta */
  dict?: Dict;
}

/** data/hora com fuso -> Date; undefined se fora do formato */
function parseDh(s?: string): Date | undefined {
  if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2})$/.test(s)) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}
/**
 * Percentual derivado de valores arredondados. Só devolve valor exato quando um percentual inteiro
 * reproduz os valores do arquivo; nos outros casos devolve "≈" + aproximação (não pode ser inserido sem conferência).
 */
function nicePct(raw: number, reproduces: (c: number) => boolean): string {
  // só percentual inteiro (ex.: 100%) é conclusivo; com casas decimais, vários valores fecham a mesma conta
  const c = Math.round(raw);
  if (reproduces(c)) return c.toFixed(2);
  // precisa de 4 casas: vários percentuais fecham a conta com os valores arredondados; não dá para saber o exato
  return '≈' + raw.toFixed(4);
}
/** prévia de percentual: valor aproximado não pode ser inserido sem conferência */
function pctGhost(tag: string, v: string, note: string): [string, string, { note?: string }] {
  if (!v.startsWith('≈')) return [tag, `<${tag}>${v}</${tag}>`, { note }];
  return [tag, `<${tag}>…</${tag}>`, { note: `${note} Dá aproximadamente ${v.slice(1)}%, mas com os valores arredondados do arquivo mais de um percentual fecha a conta (ex.: 41,18% e 41,1765%): use o percentual exato da legislação ou do cadastro.` }];
}
/** escreve o instante d no fuso indicado (ex.: -03:00) */
function withOffset(d: Date, off: string): string {
  const mins = (off[0] === '-' ? -1 : 1) * (+off.slice(1, 3) * 60 + +off.slice(4, 6));
  const t = new Date(d.getTime() + mins * 60000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}${off}`;
}
const fmtData = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

const NUM = /^-?\d+(\.\d+)?$/;
const num = (n: XNode | undefined): number | undefined => {
  if (!n || n.text === undefined || !NUM.test(n.text.trim())) return undefined;
  return Number(n.text);
};
/** valor presente mas não numérico (ex.: "1.500,00", "1e3"): o schema já acusa; as somas que dependem dele são puladas */
const bad = (n: XNode | undefined) => !!n && n.text !== undefined && n.text.trim() !== '' && !NUM.test(n.text.trim());
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const cents = (v: number) => Math.round(v * 100);
const brl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt2 = (v: number) => v.toFixed(2);
const pct = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 4 }) + '%';

/** ICMSxx dentro de ICMS (ou o próprio grupo do Simples) */
const icmsGroup = (det: XNode) => select(det, 'imposto/ICMS')?.children[0];

export function summarize(nfe: XNode, root: XNode): DocSummary {
  const inf = child(nfe, 'infNFe');
  const ide = child(inf, 'ide');
  const emit = child(inf, 'emit');
  const dest = child(inf, 'dest');
  const id = attr(inf, 'Id') ?? '';
  const prot = root.name === 'nfeProc' ? select(root, 'protNFe/infProt') : undefined;
  return {
    modelo: child(ide, 'mod')?.text,
    numero: child(ide, 'nNF')?.text,
    serie: child(ide, 'serie')?.text,
    chave: id.replace(/^NFe/, '') || undefined,
    emitente: [child(emit, 'xNome')?.text, child(emit, 'CNPJ')?.text ?? child(emit, 'CPF')?.text].filter(Boolean).join(' · ') || undefined,
    destinatario: [child(dest, 'xNome')?.text, child(dest, 'CNPJ')?.text ?? child(dest, 'CPF')?.text ?? child(dest, 'idEstrangeiro')?.text].filter(Boolean).join(' · ') || undefined,
    dhEmi: child(ide, 'dhEmi')?.text,
    vNF: select(inf, 'total/ICMSTot/vNF')?.text,
    itens: childrenNamed(inf, 'det').length,
    tpAmb: child(ide, 'tpAmb')?.text,
    autorizada: prot ? ['100', '150'].includes(child(prot, 'cStat')?.text ?? '') : undefined,
  };
}

/* ---------------- chave de acesso ---------------- */
export function dvChave(c43: string): number {
  let w = 2, s = 0;
  for (let i = c43.length - 1; i >= 0; i--) {
    s += (c43.charCodeAt(i) - 48) * w; // vale para CNPJ alfanumérico
    w = w === 9 ? 2 : w + 1;
  }
  const r = s % 11;
  return r < 2 ? 0 : 11 - r;
}
export function chaveFromIde(inf: XNode): string | undefined {
  const ide = child(inf, 'ide');
  const emit = child(inf, 'emit');
  const g = (n: string) => child(ide, n)?.text ?? '';
  const dh = g('dhEmi');
  const doc = (child(emit, 'CNPJ')?.text ?? (child(emit, 'CPF')?.text ? '000' + child(emit, 'CPF')!.text : '')).toUpperCase();
  if (!g('cUF') || !/^\d{4}-\d{2}/.test(dh) || doc.length !== 14 || !g('mod') || !g('serie') || !g('nNF') || !g('tpEmis') || !g('cNF')) return undefined;
  const c43 = g('cUF').padStart(2, '0') + dh.slice(2, 4) + dh.slice(5, 7) + doc + g('mod').padStart(2, '0') + g('serie').padStart(3, '0') + g('nNF').padStart(9, '0') + g('tpEmis') + g('cNF').padStart(8, '0');
  if (c43.length !== 43) return undefined;
  return c43 + dvChave(c43);
}

/* ---------------- fuso por UF ---------------- */
const FUSO: Record<string, string[]> = { AC: ['-05:00'], AM: ['-04:00', '-05:00'], RO: ['-04:00'], RR: ['-04:00'], MT: ['-04:00'], MS: ['-04:00'] };
const UF_COD: Record<string, string> = { '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO', '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF' };

export function runNfeRules(nfe: XNode, ctx: RuleCtx): Finding[] {
  const out: Finding[] = [];
  const inf = child(nfe, 'infNFe');
  if (!inf) return out;
  const ide = child(inf, 'ide');
  const emit = child(inf, 'emit');
  const dest = child(inf, 'dest');
  const dets = childrenNamed(inf, 'det');
  const tot = select(inf, 'total/ICMSTot');

  const at = (n: XNode | undefined) => ({ path: n ? humanPath(n) : undefined, line: ctx.lineOf(n), tx2Field: ctx.fieldOf(n) });
  const ghosts = (parent: XNode | undefined, items: [string, string?, { note?: string; values?: Record<string, string> }?][]) => {
    if (!ctx.dict) return undefined;
    const gs = items.map(([n, t, extra]) => { const g = ghostFor(ctx.dict!, parent, n, t, extra?.values); return g && extra ? { ...g, ...extra } : g; }).filter((g): g is NonNullable<typeof g> => !!g);
    return gs.length ? gs : undefined;
  };
  /** valor do item para base de cálculo: vProd − vDesc + vFrete + vSeg + vOutro */
  const itemValue = (det: XNode) => {
    const pr = child(det, 'prod');
    const v = (t: string) => num(child(pr, t)) ?? 0;
    return num(child(pr, 'vProd')) === undefined ? undefined : v('vProd') - v('vDesc') + v('vFrete') + v('vSeg') + v('vOutro');
  };
  const itemLabel = (det: XNode) => `item ${attr(det, 'nItem') ?? dets.indexOf(det) + 1}`;

  /** confere valor x esperado; tol em reais */
  /** valores de item que estão com a conta errada -> valor que fecha a conta */
  const corrections = new Map<XNode, number>();
  /** valor do campo já corrigido, quando uma conta anterior apontou erro nele */
  const val = (n: XNode | undefined) => (n && corrections.has(n) ? corrections.get(n)! : num(n));
  const findingOf = (n: XNode) => out.find((f) => f.origin === 'calculo' && f.line === ctx.lineOf(n) && f.found === n.text);
  /**
   * Total que não bate com a soma dos itens. Se a diferença some quando os itens com conta errada
   * são corrigidos, o erro está no item: não sugere mexer no total e avisa no card do item.
   */
  const checkTotal = (o: { node: XNode | undefined; parts: (XNode | undefined)[]; code?: string; title: string; how: string; missing?: string }) => {
    if (!o.node || o.parts.some(bad)) return;
    const v = num(o.node);
    if (v === undefined) return;
    const raw = o.parts.reduce((acc, n) => acc + cents(num(n) ?? 0), 0) / 100;
    const fixed = o.parts.reduce((acc, n) => acc + cents(n && corrections.has(n) ? corrections.get(n)! : num(n) ?? 0), 0) / 100;
    if (Math.abs(r2(v - raw)) < 0.005) return;
    if (Math.abs(r2(v - fixed)) < 0.005) {
      // a SEFAZ soma os itens como estão: a rejeição acontece, mas quem precisa mudar é o item
      for (const n of o.parts) if (n && corrections.has(n)) {
        const f = findingOf(n);
        if (!f || f.message.includes(`total ${o.node.name} `)) continue;
        f.sev = 'erro';
        // a rejeição do total é Obrig.; a do item 528 é Facul. (por UF), então vale a do total
        if (o.code && (!f.code || f.code === '528')) f.code = o.code;
        f.message = `A SEFAZ soma os itens como estão e rejeita${o.code ? ` com ${o.code}` : ''} (total ${o.node.name} diferente da soma). O total ${o.node.name} da nota já está com o valor certo: o que precisa ser corrigido é este campo do item. ` + f.message;
      }
      return;
    }
    if (o.missing) {
      // um item está sem o grupo: somar os outros e sugerir esse total pioraria a nota
      out.push({ sev: 'erro', origin: 'calculo', code: o.code, title: o.title, message: `${o.how} dá ${brl(raw)}, mas ${o.missing}. Corrija o item antes de mexer no total.`, ...at(o.node), found: o.node.text, fix: { text: 'Gere o grupo que falta no item; depois valide de novo.' } });
      return;
    }
    check({ node: o.node, expected: raw, code: o.code, sev: 'erro', title: o.title, how: o.how });
  };
  const check = (o: {
    node: XNode | undefined; expected: number; tol?: number; sev?: Finding['sev']; code?: string;
    title: string; how: string; extra?: string; parentForMissing?: XNode;
  }) => {
    const v = num(o.node);
    if (v === undefined || isNaN(o.expected)) return;
    const diff = r2(v - o.expected);
    if (Math.abs(diff) <= (o.tol ?? 0) + 1e-9) return;
    corrections.set(o.node!, r2(o.expected));
    out.push({
      sev: o.sev ?? 'erro', origin: 'calculo', code: o.code,
      title: o.title,
      message: `${o.how}. Diferença de R$ ${brl(Math.abs(diff))}${diff > 0 ? ' a mais' : ' a menos'} no XML.${o.extra ? ' ' + o.extra : ''}`,
      ...at(o.node),
      found: o.node!.text,
      expected: fmt2(r2(o.expected)),
      fix: { text: 'Valor que fecha a conta com os demais campos da nota. Se o valor do XML estiver certo, o erro está em algum dos campos usados no cálculo.', value: fmt2(r2(o.expected)) },
    });
  };

  /* ---------- chave de acesso ---------- */
  const id = attr(inf, 'Id');
  // no TX2 a chave está na linha do Id_A03; no XML, na linha do <infNFe>
  const idAttr = inf.attrs.find((a) => a.name === 'Id');
  const atId = { path: humanPath(inf) + ' / @Id', line: idAttr?.tx2Line ?? ctx.lineOf(inf), tx2Field: idAttr?.tx2Field };
  const calc = chaveFromIde(inf);
  if (id && calc && /^NFe/.test(id)) {
    const chave = id.slice(3);
    if (chave.slice(0, 43) !== calc.slice(0, 43)) {
      const parts: [string, number, number][] = [['cUF', 0, 2], ['ano/mês (dhEmi)', 2, 6], ['CNPJ/CPF do emitente', 6, 20], ['modelo', 20, 22], ['série', 22, 25], ['número', 25, 34], ['tpEmis', 34, 35], ['cNF', 35, 43]];
      const diffs = parts.filter(([, a, b]) => chave.slice(a, b) !== calc.slice(a, b)).map(([n]) => n);
      out.push({
        sev: 'erro', origin: 'regra', code: '502',
        title: 'Chave de acesso não bate com os dados da nota',
        message: `O atributo Id não corresponde aos campos da nota. Diferem: ${diffs.join(', ')}.`,
        ...atId, found: chave, expected: calc,
        fix: { text: 'Chave montada a partir dos campos da ide e do emitente. Confira se o campo divergente é que está errado antes de trocar a chave.', value: 'NFe' + calc },
      });
    } else if (chave[43] !== calc[43]) {
      out.push({
        sev: 'erro', origin: 'regra',
        title: 'Dígito verificador da chave incorreto',
        message: `O último dígito da chave deveria ser ${calc[43]} (módulo 11).`,
        ...atId, found: chave, expected: calc,
        fix: { text: 'Chave com o DV recalculado.', value: 'NFe' + calc },
      });
    }
    const cDV = child(ide, 'cDV');
    if (cDV?.text && cDV.text !== calc[43]) {
      out.push({
        sev: 'erro', origin: 'regra', title: 'cDV diferente do dígito da chave',
        message: `ide/cDV deve ser igual ao último dígito da chave de acesso (${calc[43]}).`,
        ...at(cDV), found: cDV.text, expected: calc[43], fix: { text: 'Use o DV calculado.', value: calc[43] },
      });
    }
  }

  /* ---------- prazos de emissão e saída ---------- */
  const dhEmiN = child(ide, 'dhEmi'), dhSaiN = child(ide, 'dhSaiEnt');
  const dEmi = parseDh(dhEmiN?.text), dSai = parseDh(dhSaiN?.text);
  if (dEmi && dSai && dSai.getTime() < dEmi.getTime() && child(ide, 'mod')?.text !== '65' && child(ide, 'tpNF')?.text === '1') {
    out.push({
      sev: 'erro', origin: 'regra', code: '506',
      title: 'Data de saída/entrada anterior à emissão',
      message: `dhSaiEnt (${dhSaiN!.text}) é anterior a dhEmi (${dhEmiN!.text}). A data de saída/entrada precisa ser igual ou posterior à emissão, então não serve para "voltar" a data de uma operação antiga.`,
      ...at(dhSaiN), found: dhSaiN!.text, expected: `igual ou posterior a ${dhEmiN!.text}`,
      fix: { text: 'Use a mesma data/hora da emissão (ou posterior), ou não informe dhSaiEnt (campo opcional na NF-e).', value: dhEmiN!.text },
    });
  }
  if (dEmi && !ctx.autorizada) {
    const now = ctx.now ?? new Date();
    const dias = (now.getTime() - dEmi.getTime()) / 86400000;
    const tpEmis = child(ide, 'tpEmis')?.text ?? '1';
    if (dias > 30 && ['1', '6', '7'].includes(tpEmis)) {
      const assinado = !!child(nfe, 'Signature');
      out.push({
        sev: assinado ? 'aviso' : 'erro', origin: 'regra', code: '228',
        title: 'Data de emissão muito atrasada',
        message: `${assinado ? 'O XML está assinado e sem protocolo: se esta nota já foi autorizada, ignore este aviso. Se ainda vai ser transmitida: ' : ''}dhEmi é de ${fmtData(dEmi)}, ${Math.floor(dias)} dias antes de hoje (${fmtData(now)}). A SEFAZ rejeita emissão com mais de 30 dias de atraso (o limite pode ser menor em algumas UFs). Para operação antiga, a nota sai com a data de hoje e a data real da operação vai nas informações complementares, conforme orientação do contador.`,
        ...at(dhEmiN), found: dhEmiN!.text,
        fix: { text: 'Corrija dhEmi (e dhSaiEnt) para a data/hora do envio. Mudar o mês da emissão muda a chave de acesso (AAMM) e o cDV: gere a nota de novo pelo sistema ou recalcule a chave.' },
      });
    } else if (dias < -5 / 1440) {
      out.push({
        sev: 'aviso', origin: 'regra', code: '703',
        title: 'Data de emissão no futuro',
        message: `dhEmi (${dhEmiN!.text}) é posterior ao horário atual. Se for transmitida agora, a SEFAZ rejeita por emissão posterior ao recebimento.`,
        ...at(dhEmiN), found: dhEmiN!.text,
        fix: { text: 'Use a data/hora real do envio. Confira também o fuso horário.' },
      });
    }
  }

  /* ---------- fuso horário ---------- */
  const ufEmit = child(child(emit, 'enderEmit'), 'UF')?.text ?? UF_COD[child(ide, 'cUF')?.text ?? ''];
  const noronha = child(ide, 'cMunFG')?.text === '2605459';
  for (const tag of ['dhEmi', 'dhSaiEnt']) {
    const n = child(ide, tag);
    const m = /([+-]\d{2}:\d{2})$/.exec(n?.text ?? '');
    const d = parseDh(n?.text);
    if (!n || !m || !d || !ufEmit) continue;
    const allowed = noronha ? ['-02:00'] : FUSO[ufEmit] ?? ['-03:00'];
    if (allowed.includes(m[1])) continue;
    const off = (o: string) => (o[0] === '-' ? -1 : 1) * (+o.slice(1, 3) * 60 + +o.slice(4, 6));
    const ahead = off(m[1]) > off(allowed[0]); // ex.: -02:00 num lugar de -03:00
    const mesmoInstante = withOffset(d, allowed[0]);
    const soFuso = n.text!.replace(/[+-]\d{2}:\d{2}$/, allowed[0]);
    const utc = /^[+-]00:00$/.test(m[1]);
    const hint = m[1] === '-02:00' ? ' O Brasil não tem horário de verão desde 2019; -02:00 só vale para Fernando de Noronha.' : utc ? ' Fuso 00:00 é o horário UTC: ou a rotina gravou a hora em UTC (aí o valor sugerido está certo), ou gravou a hora local e esqueceu o fuso.' : '';
    out.push({
      sev: 'aviso', origin: 'regra',
      title: `Fuso horário de ${tag} incomum para ${ufEmit}`,
      message: `O fuso ${m[1]} não é o usado em ${ufEmit} (${allowed.join(' ou ')}).${hint}${utc ? '' : ' O caso mais comum é o servidor com horário de verão desatualizado: o instante está certo e'} ${utc ? 'Mesmo instante no fuso da UF:' : 'a hora local real é'} ${mesmoInstante.slice(11, 19)} (valor sugerido). Se a hora ${n.text!.slice(11, 19)} é a hora local certa e só o fuso está errado, o valor é ${soFuso}${ahead ? ', mas aí o instante enviado hoje está 1 hora no futuro e a SEFAZ pode rejeitar com 703 se a nota for transmitida logo' : ''}.`,
      code: tag === 'dhEmi' && ahead ? '703' : undefined,
      ...at(n), found: n.text, expected: `fuso ${allowed[0]}`,
      fix: { text: 'Mesmo instante, escrito no fuso da UF. Corrija também a configuração de fuso/horário de verão do servidor ou da rotina que monta a data.', value: mesmoInstante },
    });
  }

  /* ---------- CFOP x tipo/destino ---------- */
  const tpNF = child(ide, 'tpNF')?.text;
  const idDest = child(ide, 'idDest')?.text;
  for (const det of dets) {
    const cfopN = select(det, 'prod/CFOP');
    const cfop = cfopN?.text ?? '';
    if (!/^\d{4}$/.test(cfop)) continue;
    const d0 = cfop[0];
    if (tpNF === '1' && '123'.includes(d0)) out.push({ sev: 'erro', origin: 'regra', code: '518', title: `CFOP de entrada em nota de saída (${itemLabel(det)})`, message: `A nota é de saída (tpNF=1), mas o CFOP ${cfop} começa com ${d0} (entrada).`, ...at(cfopN), found: cfop, fix: { text: 'Confira o CFOP do item ou o tipo da nota (tpNF).' } });
    if (tpNF === '0' && '567'.includes(d0)) out.push({ sev: 'erro', origin: 'regra', code: '519', title: `CFOP de saída em nota de entrada (${itemLabel(det)})`, message: `A nota é de entrada (tpNF=0), mas o CFOP ${cfop} começa com ${d0} (saída).`, ...at(cfopN), found: cfop, fix: { text: 'Confira o CFOP do item ou o tipo da nota (tpNF).' } });
    const esperado = idDest === '1' ? '15' : idDest === '2' ? '26' : idDest === '3' ? '37' : '';
    const ufConsEX = select(det, 'prod/comb/UFCons')?.text === 'EX';
    if (esperado && !esperado.includes(d0) && !(d0 === '7' && ufConsEX)) {
      const nome = idDest === '1' ? 'interna' : idDest === '2' ? 'interestadual' : 'com o exterior';
      // MOC I08-30/40/50: o código depende do tipo do CFOP (3/7 exterior, 2/6 interestadual, 1/5 interna)
      const codeCfop = '37'.includes(d0) ? '731' : '26'.includes(d0) ? '732' : '733';
      out.push({ sev: 'erro', origin: 'regra', code: codeCfop, title: `CFOP incompatível com operação ${nome} (${itemLabel(det)})`, message: `idDest=${idDest} (operação ${nome}) exige CFOP iniciado em ${esperado.split('').join(' ou ')}; o item usa ${cfop}.`, ...at(cfopN), found: cfop, fix: { text: 'Confira o CFOP do item ou o idDest (UF do destinatário).' } });
    }
  }
  /* ---------- documentos referenciados e devolução ---------- */
  const fin = child(ide, 'finNFe')?.text;
  const refs = childrenNamed(ide, 'NFref');
  // B25-70: a regra não vale para devolução com CFOP 1.201, 1.202, 1.410, 1.411, 5.921 e 6.921 (NT 2013/005)
  const semRefOk = dets.length > 0 && dets.every((d) => ['1201', '1202', '1410', '1411', '5921', '6921'].includes(select(d, 'prod/CFOP')?.text ?? ''));
  // NT 2025.002-RTC: a nota original pode ser referenciada no cabeçalho (NFref) ou no item (DFeReferenciado)
  const dfeRefs = dets.map((d) => select(d, 'DFeReferenciado/chaveAcesso')).filter((n): n is XNode => !!n?.text);
  if (fin === '4' && !refs.length && !dfeRefs.length && !semRefOk) {
    out.push({
      sev: 'erro', origin: 'regra', code: '321',
      title: 'Devolução sem documento referenciado',
      message: 'A nota é de devolução (finNFe=4), mas não referencia a nota original: não tem NFref no cabeçalho nem DFeReferenciado nos itens. A referência pode ir no cabeçalho (refNFe, refNFP, refNF, refECF) ou, pela NT 2025.002 (reforma tributária), em cada item (DFeReferenciado).',
      ...at(child(ide, 'finNFe')),
      fix: { text: 'Inclua a chave da nota que está sendo devolvida: no cabeçalho (no TX2, refNFe_BA02=<chave>, logo depois do bloco da ide) ou no item (chaveAcesso_VC02=<chave> e nItem_VC03=<item da nota original>).' },
    });
  }
  if (fin === '4' && dfeRefs.length && refs.some((r) => child(r, 'refNFe'))) {
    out.push({
      sev: 'aviso', origin: 'regra',
      title: 'Devolução referenciada no cabeçalho e no item ao mesmo tempo',
      message: 'Pela NT 2025.002-RTC v1.53 a nota original vai no cabeçalho (refNFe) ou no item (DFeReferenciado), mas não nas duas formas. A regra entra em vigor em novembro de 2026 (homologação dia 09, produção dia 16).',
      ...at(dfeRefs[0]),
      fix: { text: 'Deixe a referência em um lugar só.' },
    });
  }
  for (const k of dfeRefs) {
    const key = k.text!.trim();
    if (/^\d{44}$/.test(key) && String(dvChave(key.slice(0, 43))) !== key[43]) {
      out.push({
        sev: 'erro', origin: 'regra',
        title: 'Chave referenciada no item com dígito verificador inválido',
        message: `A chave ${key} (DFeReferenciado) não fecha no dígito verificador: o último dígito deveria ser ${dvChave(key.slice(0, 43))}. Provavelmente foi digitada ou copiada errada.`,
        ...at(k), found: key,
        fix: { text: 'Copie a chave de novo do XML ou do DANFE da nota original.' },
      });
    }
  }
  const ownKey = attr(inf, 'Id')?.replace(/^NFe/, '');
  for (const r of refs) {
    const k = child(r, 'refNFe') ?? child(r, 'refNFeSig');
    const key = k?.text?.trim();
    if (!k || !key || !/^\d{6}[0-9A-Z]{12}\d{26}$/.test(key)) continue;
    const dv = dvChave(key.slice(0, 43));
    if (String(dv) !== key[43]) {
      out.push({
        sev: 'erro', origin: 'regra', code: '547',
        title: 'Chave referenciada com dígito verificador inválido',
        message: `A chave ${key} não fecha no dígito verificador (o último dígito deveria ser ${dv}). Normalmente é chave digitada ou copiada errada.`,
        ...at(k), found: key,
        fix: { text: 'Copie a chave de novo do XML ou do DANFE da nota original. Não corrija só o último dígito: se o DV não fecha, algum outro dígito está errado.' },
      });
    } else if (ownKey && key === ownKey) {
      out.push({ sev: 'erro', origin: 'regra', code: '316', title: 'A nota referencia a própria chave', message: 'O refNFe é igual à chave desta nota. A referência deve ser a nota original (a que está sendo devolvida, complementada ou ajustada).', ...at(k), found: key, fix: { text: 'Troque pela chave da nota original.' } });
    }
  }
  // CFOP de devolução (tabela CFOP do Portal da NF-e, indDevol=1): conjunto mais usado; avisos, porque a lista oficial é maior
  const CFOP_DEVOL = /^[1-37]?(201|202|203|204|208|209|210|211|212|213|214|215|216|410|411|412|413|503|504|505|506|553|555|556|660|661|662|918|919)$|^[5-7](201|202|208|209|210|211|212|213|214|215|216|410|411|412|413|503|553|555|556|660|661|662|918|919)$/;
  const CFOP_VENDA_COMPRA = /^[1-35-7](10[1-9]|11[0-9]|12[0-6])$/;
  for (const det of dets) {
    const cN = select(det, 'prod/CFOP');
    const cfop = cN?.text ?? '';
    if (!/^\d{4}$/.test(cfop)) continue;
    const devol = CFOP_DEVOL.test(cfop);
    if ((fin === '1' || fin === '3') && devol) {
      out.push({ sev: 'aviso', origin: 'regra', code: '328', title: `CFOP de devolução em nota que não é de devolução (${itemLabel(det)})`, message: `O CFOP ${cfop} é de devolução, mas finNFe=${fin} (${fin === '1' ? 'normal' : 'ajuste'}). A SEFAZ rejeita CFOP de devolução fora de nota com finalidade 4 (devolução) ou 2 (complementar).`, ...at(cN), found: cfop, fix: { text: 'Se é mesmo devolução, use finNFe=4 e referencie a nota original. Se não é, confira o CFOP da natureza de operação.', value: undefined } });
    }
    if (fin === '4' && CFOP_VENDA_COMPRA.test(cfop)) {
      out.push({ sev: 'aviso', origin: 'regra', code: '327', title: `CFOP de venda/compra em nota de devolução (${itemLabel(det)})`, message: `A nota é de devolução (finNFe=4), mas o CFOP ${cfop} é de venda ou compra normal. A SEFAZ só aceita CFOP de devolução (tabela CFOP, indDevol=1) e, para devolução de não contribuinte, 1.949/2.949.`, ...at(cN), found: cfop, fix: { text: 'Use o CFOP de devolução correspondente (ex.: venda 5.102 → devolução de compra 5.202 / entrada 1.202).' } });
    }
  }

  const ufDest = select(dest, 'enderDest/UF')?.text;
  const entregaOuRetirada = !!child(inf, 'entrega') || !!child(inf, 'retirada');
  const mesmoCnpj = !!child(dest, 'CNPJ')?.text && child(dest, 'CNPJ')?.text === child(emit, 'CNPJ')?.text;
  if (ufEmit && ufDest && idDest && !entregaOuRetirada) {
    if (idDest === '1' && ufDest !== ufEmit && ufDest !== 'EX' && child(ide, 'indFinal')?.text === '0') out.push({ sev: 'erro', origin: 'regra', code: '773', title: 'Operação marcada como interna para outra UF', message: `idDest=1 (interna), mas o emitente é de ${ufEmit} e o destinatário de ${ufDest}.`, ...at(child(ide, 'idDest')), found: idDest, expected: '2', fix: { text: 'Para destinatário de outra UF, idDest deve ser 2 (interestadual).', value: '2' } });
    if (idDest === '2' && ufDest === ufEmit && !mesmoCnpj) out.push({ sev: 'erro', origin: 'regra', code: '772', title: 'Operação marcada como interestadual na mesma UF', message: `idDest=2 (interestadual), mas emitente e destinatário são de ${ufEmit}.`, ...at(child(ide, 'idDest')), found: idDest, expected: '1', fix: { text: 'Para destinatário da mesma UF, idDest deve ser 1 (interna) — a menos que a entrega seja em outra UF.', value: '1' } });
  }

  /* ---------- não contribuinte ---------- */
  const indIEDest = child(dest, 'indIEDest')?.text;
  const finNFe = child(ide, 'finNFe')?.text;
  const mod = child(ide, 'mod')?.text;
  if (indIEDest === '9') {
    const indFinal = child(ide, 'indFinal');
    if (mod === '55' && indFinal?.text === '0' && child(ide, 'tpNF')?.text === '1' && child(ide, 'idDest')?.text !== '3') {
      out.push({ sev: 'erro', origin: 'regra', code: '696', title: 'Não contribuinte sem indicação de consumidor final', message: 'Destinatário marcado como não contribuinte (indIEDest=9), mas indFinal=0. Operação com não contribuinte deve ser com consumidor final.', ...at(indFinal), found: '0', expected: '1', fix: { text: 'Se o destinatário é mesmo não contribuinte, indFinal deve ser 1. Se ele tem IE, o erro está no indIEDest do cadastro.', value: '1' } });
    }
    const permitidos = ['00', '20', '40', '41', '60'];
    const excecaoCfop = ['5123', '5922', '6123', '6922'];
    const excecao = (cst: string, cfop: string, det: XNode) =>
      excecaoCfop.includes(cfop) || !!select(det, 'prod/veicProd') ||
      (cst === '50' && /^[56]9/.test(cfop)) ||
      (cst === '51' && ['5906', '5907', '6906', '6907'].includes(cfop)) ||
      (cst === '10' && idDest === '1') ||
      (finNFe === '4' && ['50', '51'].includes(cst));
    for (const det of dets) {
      if (tpNF !== '1') break;
      const g = icmsGroup(det);
      const cst = child(g, 'CST');
      const cfop = select(det, 'prod/CFOP')?.text ?? '';
      if (cst?.text && !permitidos.includes(cst.text) && !excecao(cst.text, cfop, det)) {
        out.push({
          sev: 'aviso', origin: 'regra', code: '508',
          title: `CST ${cst.text} com destinatário não contribuinte (${itemLabel(det)})`,
          message: `Com indIEDest=9 a SEFAZ costuma aceitar só CST ${permitidos.join(', ')} (fora devolução e alguns CFOPs). Antes de mudar a tributação, confira o cadastro do cliente: "isento de IE" é indIEDest=2, não 9; produtor rural normalmente é contribuinte.`,
          ...at(cst), found: cst.text,
          fix: { text: 'Primeiro valide a IE do destinatário (CCC/SINTEGRA). Só altere CST com o contador.' },
        });
      }
    }
  }

  /* ---------- itens ---------- */
  const ufEmitIt = child(child(emit, 'enderEmit'), 'UF')?.text ?? UF_COD[child(ide, 'cUF')?.text ?? ''];
  const anyIBS = dets.some((d) => select(d, 'imposto/IBSCBS'));
  /** base do IBS/CBS de um item sem o grupo, pela fórmula que os outros itens desta nota seguem */
  const ibsBaseFor = (det: XNode): { values?: Record<string, string>; note: string } => {
    const fiscal = 'CST, cClassTrib e alíquotas dependem do cadastro de tributação do produto e não são preenchidos.';
    const parts = (d: XNode) => {
      const vi = itemValue(d);
      if (vi === undefined) return undefined;
      const g = icmsGroup(d);
      const z = (n?: XNode) => num(n) ?? 0;
      // ICMS e parcelas que também saem da base do IBS/CBS (NT 2025.002): FCP, ICMS monofásico, difal, ISSQN
      const icms = z(child(g, 'vICMS')) + z(child(g, 'vFCP')) + z(child(g, 'vICMSMono')) + z(select(d, 'imposto/ICMSUFDest/vICMSUFDest')) + z(select(d, 'imposto/ICMSUFDest/vFCPUFDest')) + z(select(d, 'imposto/ISSQN/vISSQN'));
      const pis = z(child(select(d, 'imposto/PIS')?.children[0], 'vPIS'));
      const cof = z(child(select(d, 'imposto/COFINS')?.children[0], 'vCOFINS'));
      return { vi, icms, pis, cof };
    };
    const formulas: [string, (x: NonNullable<ReturnType<typeof parts>>) => number][] = [
      ['valor do item', (x) => x.vi],
      ['valor do item − ICMS (com FCP, difal e monofásico, quando houver)', (x) => x.vi - x.icms],
      ['valor do item − ICMS (com FCP, difal e monofásico) − PIS − COFINS', (x) => x.vi - x.icms - x.pis - x.cof],
    ];
    const refs = dets.filter((d) => d !== det && num(select(d, 'imposto/IBSCBS/gIBSCBS/vBC')) !== undefined);
    const me = parts(det);
    if (!refs.length || !me) return { note: fiscal };
    const ok = formulas.filter(([, fn]) => refs.every((d) => { const x = parts(d); return x && Math.abs(fn(x) - num(select(d, 'imposto/IBSCBS/gIBSCBS/vBC'))!) <= 0.01; }));
    const results = [...new Set(ok.map(([, fn]) => fmt2(r2(fn(me)))))];
    if (ok.length && results.length === 1) {
      return { values: { vBC: results[0] }, note: `vBC = ${ok[0][0]} = ${results[0]}, a mesma regra que os outros itens desta nota seguem. ${fiscal}` };
    }
    return { note: (ok.length ? 'A base (vBC) não sai de conta com segurança: mais de uma regra serve para os outros itens e elas dão valores diferentes neste. ' : '') + fiscal };
  };
  for (const det of dets) {
    const lbl = itemLabel(det);
    const prod = child(det, 'prod');
    const q = num(child(prod, 'qCom')), vu = num(child(prod, 'vUnCom'));
    if (q !== undefined && vu !== undefined && q > 0 && vu > 0 && !['2', '3'].includes(finNFe ?? '1')) {
      const normal = (finNFe ?? '1') === '1';
      check({ node: child(prod, 'vProd'), expected: q * vu, tol: 0.01, code: normal ? '629' : undefined, sev: normal ? 'erro' : 'aviso', title: `vProd diferente de qCom × vUnCom (${lbl})`, how: `${q} × ${vu} = ${fmt2(r2(q * vu))}`, extra: normal ? undefined : 'Fora da NF-e normal (finNFe=1) a SEFAZ não confere esta conta, mas os totais da nota somam o vProd como está.' });
    }
    const qt = num(child(prod, 'qTrib')), vut = num(child(prod, 'vUnTrib'));
    if (qt !== undefined && vut !== undefined && qt > 0 && vut > 0 && !['2', '3'].includes(finNFe ?? '1') && num(child(prod, 'vProd')) !== undefined) {
      const e = qt * vut;
      if (Math.abs(r2(e) - num(child(prod, 'vProd'))!) > 0.01) {
        out.push({ sev: 'aviso', origin: 'calculo', code: (finNFe ?? '1') === '1' ? '630' : undefined, title: `qTrib × vUnTrib não bate com vProd (${lbl})`, message: `${qt} × ${vut} = ${fmt2(r2(e))}, mas vProd é ${child(prod, 'vProd')!.text}. Algumas UFs rejeitam essa diferença.`, ...at(child(prod, 'vUnTrib')), found: child(prod, 'vUnTrib')!.text, fix: { text: 'Confira unidade e quantidade tributável (uTrib/qTrib) em relação à comercial.' } });
      }
    }

    // ICMS
    const g = icmsGroup(det);
    if (g) {
      const vBC = num(child(g, 'vBC')), p = num(child(g, 'pICMS'));
      if (g.name === 'ICMS51') {
        if (vBC !== undefined && p !== undefined) check({ node: child(g, 'vICMSOp'), expected: (vBC * p) / 100, tol: 0.01, sev: 'aviso', code: '351', title: `vICMSOp diferente de vBC × pICMS (${lbl})`, how: `${fmt2(vBC)} × ${pct(p)} = ${fmt2(r2((vBC * p) / 100))}` });
        const vOp = val(child(g, 'vICMSOp')), pDif = num(child(g, 'pDif'));
        if (vOp !== undefined && pDif !== undefined) check({ node: child(g, 'vICMSDif'), expected: (vOp * pDif) / 100, tol: 0.01, sev: 'aviso', code: '352', title: `vICMSDif diferente de vICMSOp × pDif (${lbl})`, how: `${fmt2(vOp)} × ${pct(pDif)} = ${fmt2(r2((vOp * pDif) / 100))}` });
        const vDif = val(child(g, 'vICMSDif'));
        if (vOp !== undefined && vDif !== undefined) check({ node: child(g, 'vICMS'), expected: vOp - vDif, tol: 0.01, sev: 'aviso', code: '353', title: `vICMS diferente de vICMSOp − vICMSDif (${lbl})`, how: `${fmt2(vOp)} − ${fmt2(vDif)} = ${fmt2(r2(vOp - vDif))}` });
        const faltam = ['pRedBC', 'pDif'].filter((t) => !child(g, t));
        // regra N07-10 do MOC: o PR rejeita (caso real); o RS autoriza sem os campos (115 notas reais de homologação/produção)
        const sev929: Finding['sev'] | undefined = ufEmitIt === 'PR' ? 'aviso' : ufEmitIt === 'RS' ? undefined : 'info';
        if (faltam.length && sev929) {
          // aponta para o campo depois do qual o pRedBC entra (modBC, ou CST quando não há modBC)
          const anchor = child(g, 'modBC') ?? child(g, 'CST');
          const isTx2 = !!ctx.fieldOf(anchor);
          const aLine = ctx.lineOf(anchor);
          const nome = (tag: string, id: string) => (isTx2 ? `${tag}_${id}` : `<${tag}>`);
          const passos: string[] = [];
          if (faltam.includes('pRedBC')) passos.push(`${nome('pRedBC', 'N14')} (percentual de redução da base; 0.00 quando não há redução), logo depois de ${nome(anchor?.name ?? 'CST', anchor?.name === 'modBC' ? 'N13' : 'N12')}${aLine ? ` (linha ${aLine})` : ''}`);
          if (faltam.includes('pDif')) passos.push(`${nome('pDif', 'N16b')} (percentual do diferimento previsto na legislação; 100.00 quando o diferimento é total)${child(g, 'vICMSOp') ? `, depois de ${nome('vICMSOp', 'N16a')}` : ''}`);
          out.push({
            sev: sev929, origin: 'regra', code: '929',
            title: `CST 51 sem ${faltam.join(' e ')} (${lbl})`,
            message: `O grupo ICMS51 do ${lbl} está sem ${faltam.join(' e ')}. ${ufEmitIt === 'PR' ? 'O PR exige' : 'Algumas UFs (o PR, pela regra N07-10 do MOC) exigem'} esses campos sempre que o CST é 51, mesmo com valor zero, e rejeitam com 929 "CST de diferimento sem as informações de diferimento"${ufEmitIt === 'PR' ? '' : '; o RS aceita sem eles'}. O campo entra logo depois da linha marcada.`,
            ...at(anchor), found: '(ausente)',
            ghosts: ghosts(g, faltam.map((t) => {
              if (t === 'pRedBC') {
                const base = itemValue(det);
                if (vBC !== undefined && base && vBC > base + 0.005) return [t, '<pRedBC>0.00</pRedBC>', { note: `pRedBC = 0.00: a vBC (${fmt2(vBC)}) é maior que o valor do item (${fmt2(base)}), o que acontece quando IPI ou outras parcelas entram na base; não há redução.` }];
                if (vBC !== undefined && base) {
                  const red = (1 - vBC / base) * 100;
                  if (Math.abs(red) < 0.005) return [t, '<pRedBC>0.00</pRedBC>', { note: `pRedBC = 0.00: a vBC (${fmt2(vBC)}) é igual ao valor do item, então não há redução de base.` }];
                  if (red > 0 && red < 100) return pctGhost('pRedBC', nicePct(red, (c) => r2(base * (1 - c / 100)) === r2(vBC)), `pRedBC = (1 − vBC ÷ valor do item) × 100 = (1 − ${fmt2(vBC)} ÷ ${fmt2(base)}) × 100. Confira com o percentual de redução do cadastro.`);
                }
                return [t, '<pRedBC>0.00</pRedBC>', { note: 'pRedBC = 0.00: o grupo não tem vBC, então foi considerado sem redução de base. Confirme no cadastro de tributação.' }];
              }
              const vOp = num(child(g, 'vICMSOp')), vDif = num(child(g, 'vICMSDif')), vI = num(child(g, 'vICMS'));
              if (vOp && vDif !== undefined) return pctGhost('pDif', nicePct((vDif / vOp) * 100, (c) => r2((vOp * c) / 100) === r2(vDif)), `pDif = vICMSDif ÷ vICMSOp × 100 = ${fmt2(vDif)} ÷ ${fmt2(vOp)} × 100.`);
              if (vOp && vI !== undefined) return pctGhost('pDif', nicePct(((vOp - vI) / vOp) * 100, (c) => r2(vOp - r2((vOp * c) / 100)) === r2(vI)), `pDif = (vICMSOp − vICMS) ÷ vICMSOp × 100 = (${fmt2(vOp)} − ${fmt2(vI)}) ÷ ${fmt2(vOp)} × 100.`);
              return [t, '<pDif>…</pDif>', { note: 'pDif não sai de conta: o grupo não tem vICMSOp nem vICMSDif. Use o percentual do diferimento da legislação (100.0000 quando é total).' }];
            }) as [string, string, { note?: string }][]),
            fix: { text: `Inclua ${passos.join('; e ')}. Os valores que saem de conta com o próprio arquivo aparecem no trecho abaixo.` },
          });
        }
      } else if (vBC !== undefined && p !== undefined && child(g, 'vICMS')) {
        check({ node: child(g, 'vICMS'), expected: (vBC * p) / 100, tol: 0.01, sev: 'aviso', code: ['ICMS00', 'ICMS10', 'ICMS20', 'ICMS70'].includes(g.name) && (finNFe ?? '1') === '1' ? '528' : undefined, title: `vICMS diferente de vBC × pICMS (${lbl})`, how: `${fmt2(vBC)} × ${pct(p)} = ${fmt2(r2((vBC * p) / 100))}`, extra: 'Algumas SEFAZ rejeitam; outras aceitam e o erro aparece na apuração.' });
      }
      if (['ICMS10', 'ICMS70'].includes(g.name)) {
        const bST = num(child(g, 'vBCST')), pST = num(child(g, 'pICMSST')), proprio = val(child(g, 'vICMS')) ?? 0;
        if (bST !== undefined && pST !== undefined && child(g, 'vICMSST')) {
          const e = Math.max(0, (bST * pST) / 100 - proprio);
          check({ node: child(g, 'vICMSST'), expected: e, tol: 0.01, sev: 'aviso', title: `vICMSST diferente de vBCST × pICMSST − vICMS (${lbl})`, how: `${fmt2(bST)} × ${pct(pST)} − ${fmt2(proprio)} = ${fmt2(r2(e))}` });
        }
      }
      const pF = num(child(g, 'pFCP')), bF = num(child(g, 'vBCFCP')) ?? vBC;
      if (pF !== undefined && bF !== undefined) check({ node: child(g, 'vFCP'), expected: (bF * pF) / 100, tol: 0.01, sev: 'aviso', title: `vFCP diferente da base × pFCP (${lbl})`, how: `${fmt2(bF)} × ${pct(pF)} = ${fmt2(r2((bF * pF) / 100))}` });
    }

    // IPI
    const ipiT = select(det, 'imposto/IPI/IPITrib');
    if (ipiT) {
      const b = num(child(ipiT, 'vBC')), p = num(child(ipiT, 'pIPI')), qU = num(child(ipiT, 'qUnid')), vU = num(child(ipiT, 'vUnid'));
      if (b !== undefined && p !== undefined) check({ node: child(ipiT, 'vIPI'), expected: (b * p) / 100, tol: 0.01, sev: 'aviso', title: `vIPI diferente de vBC × pIPI (${lbl})`, how: `${fmt2(b)} × ${pct(p)} = ${fmt2(r2((b * p) / 100))}` });
      else if (qU !== undefined && vU !== undefined) check({ node: child(ipiT, 'vIPI'), expected: qU * vU, tol: 0.01, sev: 'aviso', title: `vIPI diferente de qUnid × vUnid (${lbl})`, how: `${qU} × ${vU} = ${fmt2(r2(qU * vU))}` });
    }
    // PIS/COFINS por alíquota
    for (const [grp, p, v] of [['PIS', 'pPIS', 'vPIS'], ['COFINS', 'pCOFINS', 'vCOFINS']] as const) {
      const gg = select(det, `imposto/${grp}`)?.children[0];
      const b = num(child(gg, 'vBC')), a = num(child(gg, p));
      if (gg && b !== undefined && a !== undefined) check({ node: child(gg, v), expected: (b * a) / 100, tol: 0.01, sev: 'aviso', title: `${v} diferente de vBC × ${p} (${lbl})`, how: `${fmt2(b)} × ${pct(a)} = ${fmt2(r2((b * a) / 100))}` });
    }

    // IBS / CBS
    const ibs = select(det, 'imposto/IBSCBS');
    if (anyIBS && !ibs) {
      out.push({
        sev: 'aviso', origin: 'regra',
        title: `${lbl[0].toUpperCase() + lbl.slice(1)} sem grupo IBSCBS`,
        message: 'Outros itens da nota têm o grupo IBS/CBS e este não. A regra que exige o grupo em todos os itens (rejeição 1115) está prevista na NT, mas hoje está suspensa em produção; quando entrar em vigor, a nota será rejeitada. Se os totais de IBS/CBS foram somados com este item, eles também não vão fechar.',
        ...at(det),
        ghosts: ghosts(child(det, 'imposto'), [['IBSCBS', undefined, ibsBaseFor(det)]]),
        fix: { text: 'Gere o grupo IBSCBS também neste item (no TX2, o bloco CST_UB13 ... vCBS_UB67 antes do SALVARITEM). Geralmente é falha na geração ou cadastro de tributação do produto incompleto.' },
      });
    }
    const gI = select(ibs, 'gIBSCBS');
    if (gI) {
      const b = num(child(gI, 'vBC'));
      const esfera = (grpName: string, pTag: string, vTag: string, nome: string) => {
        const gr = child(gI, grpName);
        if (!gr || b === undefined) return undefined;
        if (child(gr, 'gDif') || child(gr, 'gDevTrib')) return gr; // com diferimento/devolução a conta muda: não confere
        const red = child(gr, 'gRed');
        const aliq = red ? num(child(red, 'pAliqEfet')) : num(child(gr, pTag));
        if (aliq !== undefined) check({ node: child(gr, vTag), expected: (b * aliq) / 100, tol: 0.01, sev: 'aviso', title: `${vTag} diferente de vBC × alíquota${red ? ' efetiva' : ''} (${lbl})`, how: `${fmt2(b)} × ${pct(aliq)} = ${fmt2(r2((b * aliq) / 100))}` });
        if (red) {
          const pBase = num(child(gr, pTag)), pRed = num(child(red, 'pRedAliq')), pEf = num(child(red, 'pAliqEfet'));
          if (pBase !== undefined && pRed !== undefined && pEf !== undefined) {
            const e = Math.round(pBase * (1 - pRed / 100) * 10000) / 10000;
            if (Math.abs(e - pEf) > 0.0001) out.push({ sev: 'aviso', origin: 'calculo', title: `Alíquota efetiva de ${nome} não bate com a redução (${lbl})`, message: `${pct(pBase)} com redução de ${pct(pRed)} dá ${pct(e)}, mas pAliqEfet é ${pct(pEf)}.`, ...at(child(red, 'pAliqEfet')), found: child(red, 'pAliqEfet')!.text, expected: e.toFixed(4), fix: { text: 'Valor calculado a partir da alíquota e do percentual de redução.', value: e.toFixed(4) } });
          }
        }
        return gr;
      };
      const uf = esfera('gIBSUF', 'pIBSUF', 'vIBSUF', 'IBS UF');
      const mun = esfera('gIBSMun', 'pIBSMun', 'vIBSMun', 'IBS Município');
      const cbs = esfera('gCBS', 'pCBS', 'vCBS', 'CBS');
      const vU = val(child(uf, 'vIBSUF')), vM = val(child(mun, 'vIBSMun'));
      if (vU !== undefined && vM !== undefined) check({ node: child(gI, 'vIBS'), expected: vU + vM, sev: 'erro', title: `vIBS diferente de vIBSUF + vIBSMun (${lbl})`, how: `${fmt2(vU)} + ${fmt2(vM)} = ${fmt2(r2(vU + vM))}` });
      // reduções diferentes entre esferas (caso típico: município zerado porque a alíquota municipal é 0)
      const reds = [['UF', uf], ['Município', mun], ['CBS', cbs]].map(([n, gr]) => [n, num(select(gr as XNode, 'gRed/pRedAliq'))] as const).filter(([, v]) => v !== undefined);
      if (reds.length >= 2 && new Set(reds.map(([, v]) => v)).size > 1) {
        out.push({
          sev: 'aviso', origin: 'regra',
          title: `Percentual de redução diferente entre as esferas (${lbl})`,
          message: `pRedAliq: ${reds.map(([n, v]) => `${n} ${pct(v!)}`).join(', ')}. Para a maioria dos cClassTrib a redução é a mesma nas três esferas, e a SEFAZ rejeita quando não confere com a tabela. Um caso comum é a redução municipal sair 0 porque a alíquota municipal é 0 em 2026.`,
          ...at(select(mun ?? uf, 'gRed/pRedAliq')),
          fix: { text: 'Confira pRedAliq na tabela do cClassTrib. O percentual de redução não depende de a alíquota ser zero.' },
        });
      }
      // tributação regular incompleta
      const reg = child(gI, 'gTribRegular');
      if (reg) {
        const vazios = ['CSTReg', 'cClassTribReg'].filter((t) => !child(reg, t)?.text);
        if (vazios.length) out.push({ sev: 'erro', origin: 'regra', code: '225', title: `Grupo gTribRegular incompleto (${lbl})`, message: `gTribRegular foi gerado sem ${vazios.join(' e ')}. Se a operação não tem tributação regular, o grupo inteiro não deve ser gerado.`, ...at(reg), ghosts: ghosts(reg, vazios.filter((t) => !child(reg, t)).map((t) => [t] as [string])), fix: { text: 'Preencha CSTReg/cClassTribReg ou não gere gTribRegular (no TX2, campos CSTReg_UB69 e cClassTribReg_UB70 em diante).' } });
      }
    }
  }

  /* ---------- totais ICMSTot ---------- */
  if (tot) {
    // NF-e conjugada (produtos + serviços): os totais do ICMSTot somam só os itens sujeitos ao ICMS
    const conjugada = dets.some((d) => select(d, 'imposto/ISSQN'));
    const icmsDets = conjugada ? dets.filter((d) => select(d, 'imposto/ICMS')) : dets;
    const sum = (fn: (d: XNode) => XNode | undefined, filter?: (d: XNode) => boolean) => icmsDets.filter(filter ?? (() => true)).map(fn);
    const indTot1 = (d: XNode) => select(d, 'prod/indTot')?.text !== '0';
    const semICMS = icmsDets.filter((d) => !icmsGroup(d) && !select(d, 'imposto/ISSQN'));
    const faltaICMS = semICMS.length ? `${semICMS.map(itemLabel).join(', ')} ${semICMS.length > 1 ? 'estão' : 'está'} sem o grupo de ICMS` : undefined;
    const T = (tag: string, parts: (XNode | undefined)[], how: string, code?: string, icmsDep = false) =>
      checkTotal({ node: child(tot, tag), parts, code, title: `Total ${tag} diferente da soma dos itens`, how, missing: icmsDep ? faltaICMS : undefined });
    const g = (path: string) => (d: XNode) => select(d, path);
    const ic = (tag: string) => (d: XNode) => child(icmsGroup(d), tag);
    T('vBC', sum(ic('vBC')), 'Soma de vBC do ICMS dos itens', '531', true);
    T('vICMS', sum(ic('vICMS')), 'Soma de vICMS dos itens', '532', true);
    T('vICMSDeson', sum(ic('vICMSDeson')), 'Soma de vICMSDeson dos itens', '795', true);
    T('vFCP', sum(ic('vFCP')), 'Soma de vFCP dos itens', '861', true);
    T('vBCST', sum(ic('vBCST')), 'Soma de vBCST dos itens', '533', true);
    T('vST', sum(ic('vICMSST')), 'Soma de vICMSST dos itens', '534', true);
    T('vFCPST', sum(ic('vFCPST')), 'Soma de vFCPST dos itens', '862', true);
    T('vFCPSTRet', sum(ic('vFCPSTRet')), 'Soma de vFCPSTRet dos itens', '859', true);
    T('vProd', sum(g('prod/vProd'), indTot1), 'Soma de vProd dos itens que compõem o total (indTot=1)', '564');
    T('vFrete', sum(g('prod/vFrete')), 'Soma de vFrete dos itens', '535');
    T('vSeg', sum(g('prod/vSeg')), 'Soma de vSeg dos itens', '536');
    T('vDesc', sum(g('prod/vDesc')), 'Soma de vDesc dos itens', '537');
    T('vOutro', sum(g('prod/vOutro')), 'Soma de vOutro dos itens', '604');
    T('vII', sum(g('imposto/II/vII')), 'Soma de vII dos itens', '601');
    T('vIPI', sum(g('imposto/IPI/IPITrib/vIPI')), 'Soma de vIPI dos itens', '538');
    T('vIPIDevol', sum(g('impostoDevol/IPI/vIPIDevol')), 'Soma de vIPIDevol dos itens', '863');
    T('vPIS', sum((d) => child(select(d, 'imposto/PIS')?.children[0], 'vPIS')), 'Soma de vPIS dos itens', '602');
    T('vCOFINS', sum((d) => child(select(d, 'imposto/COFINS')?.children[0], 'vCOFINS')), 'Soma de vCOFINS dos itens', '603');

    // vNF
    // fora da regra: importação (CFOP 3xxx soma outros tributos) e faturamento direto de veículo novo
    const importacao = dets.some((d) => /^3/.test(select(d, 'prod/CFOP')?.text ?? ''));
    const fatDireto = dets.some((d) => select(d, 'prod/veicProd/tpOp')?.text === '2');
    if (!tot.children.some(bad) && !importacao && !fatDireto) {
      const t = (tag: string) => val(child(tot, tag)) ?? 0;
      const deson = dets.reduce((s, d) => s + (child(icmsGroup(d), 'indDeduzDeson')?.text === '1' ? cents(num(child(icmsGroup(d), 'vICMSDeson')) ?? 0) : 0), 0) / 100;
      // NF-e conjugada: o total dos serviços (ISSQNtot/vServ) também compõe o vNF (MOC W16-10)
      const vServ = num(select(inf, 'total/ISSQNtot/vServ')) ?? 0;
      let e = t('vProd') - t('vDesc') - deson + t('vST') + t('vFCPST') + t('vFrete') + t('vSeg') + t('vOutro') + t('vII') + t('vIPI') + t('vIPIDevol') + vServ;
      // exceção 3 do W16-10: não rejeitar se o ICMS desonerado não foi subtraído
      const semDeson = e + deson, vNFatual = num(child(tot, 'vNF'));
      if (deson && vNFatual !== undefined && Math.abs(r2(vNFatual - semDeson)) < 0.005) e = semDeson;
      const vNFn = child(tot, 'vNF'), vNFv = num(vNFn);
      const how = `vProd − vDesc${deson ? ' − vICMSDeson' : ''} + vST + vFCPST + vFrete + vSeg + vOutro + vII + vIPI + vIPIDevol = ${fmt2(r2(e))}`;
      // a SEFAZ tolera diferença de até R$ 0,50 no vNF
      if (vNFv !== undefined && Math.abs(r2(vNFv - e)) > 0.005 && Math.abs(r2(vNFv - e)) <= 0.5) {
        check({ node: vNFn, expected: e, sev: 'aviso', title: 'Total da nota (vNF) com diferença de centavos', how, extra: 'A SEFAZ aceita diferença de até R$ 0,50 no total da nota, então isso não rejeita; vale corrigir o arredondamento na geração.' });
      } else {
        check({ node: vNFn, expected: e, sev: 'erro', code: '610', title: 'Total da nota (vNF) não fecha com os totais', how });
      }
    }
  }

  /* ---------- totais IBS/CBS ---------- */
  const tIBS = select(inf, 'total/IBSCBSTot');
  if (tIBS && anyIBS) {
    const semIBS = dets.filter((d) => !select(d, 'imposto/IBSCBS'));
    const faltaIBS = semIBS.length ? `${semIBS.map(itemLabel).join(', ')} ${semIBS.length > 1 ? 'estão' : 'está'} sem o grupo IBSCBS` : undefined;
    const T = (tPath: string, iPath: string, code?: string) =>
      checkTotal({ node: select(tIBS, tPath), parts: dets.map((d) => select(d, 'imposto/IBSCBS/gIBSCBS/' + iPath)), code, title: `Total ${tPath.split('/').pop()} (IBS/CBS) diferente da soma dos itens`, how: `Soma de ${iPath.split('/').pop()} dos itens`, missing: faltaIBS });
    T('vBCIBSCBS', 'vBC', '1076');
    T('gIBS/gIBSUF/vIBSUF', 'gIBSUF/vIBSUF', '1080');
    T('gIBS/gIBSMun/vIBSMun', 'gIBSMun/vIBSMun', '1084');
    T('gIBS/vIBS', 'vIBS', '1085');
    T('gCBS/vCBS', 'gCBS/vCBS', '1091');
    T('gIBS/gIBSUF/vDif', 'gIBSUF/gDif/vDif');
    T('gIBS/gIBSMun/vDif', 'gIBSMun/gDif/vDif');
    T('gCBS/vDif', 'gCBS/gDif/vDif');
  }

  /* ---------- pagamento, cobrança, volumes ---------- */
  const vNF = val(select(inf, 'total/ICMSTot/vNF'));
  const pag = child(inf, 'pag');
  if (pag && vNF !== undefined) {
    const detPags = childrenNamed(pag, 'detPag');
    const semPag = detPags.some((d) => child(d, 'tPag')?.text === '90');
    const soma = detPags.reduce((s, d) => s + cents(num(child(d, 'vPag')) ?? 0), 0) / 100;
    const troco = num(child(pag, 'vTroco')) ?? 0;
    const liquido = r2(soma - troco);
    const trocoN = child(pag, 'vTroco');
    if (!semPag && trocoN && detPags.length && soma >= vNF && Math.abs(r2(liquido - vNF)) >= 0.01) {
      // YA09-10: troco = soma dos pagamentos − total da nota
      const certo = r2(soma - vNF);
      out.push({
        sev: 'erro', origin: 'calculo', code: '869', title: 'Valor do troco incorreto',
        message: `vTroco tem que ser a soma dos pagamentos (${brl(soma)}) menos o total da nota (${brl(vNF)}) = ${brl(certo)}.`,
        ...at(trocoN), found: trocoN.text, expected: certo.toFixed(2), fix: { text: 'Troco calculado com os pagamentos e o total da nota.', value: certo.toFixed(2) },
      });
    } else if (!semPag && finNFe === '1' && detPags.length && Math.abs(r2(liquido - vNF)) >= 0.01) {
      const maior = liquido > vNF;
      // NFC-e: a SEFAZ confere pagamento x total. NF-e: pagamento menor é aceito (ex.: entrada de produtor com Funrural retido)
      const sev: Finding['sev'] = mod === '65' || maior ? 'aviso' : 'info';
      const pct = vNF ? ((vNF - liquido) / vNF) * 100 : 0;
      const funrural = !maior && tpNF === '0' && Math.abs(pct - 1.5) < 0.06 ? ' A diferença é de 1,5% do total, o que costuma ser a retenção de Funrural/Senar na compra de produtor rural: nesse caso está correto.' : '';
      out.push({
        sev, origin: 'calculo', code: maior ? (troco ? undefined : '866') : mod === '65' ? '865' : undefined,
        title: maior ? 'Pagamentos maiores que o total da nota' : 'Pagamentos menores que o total da nota',
        message: `Soma de vPag (${brl(soma)})${troco ? ` − troco (${brl(troco)})` : ''} = ${brl(liquido)}, total da nota ${brl(vNF)}. ${maior ? 'Se o cliente pagou a mais, informe vTroco.' : mod === '65' ? 'Na NFC-e a SEFAZ rejeita pagamento menor que o total.' : 'Na NF-e a SEFAZ costuma aceitar; confira se não falta uma forma de pagamento.'}${funrural}`,
        ...at(detPags[0]), fix: { text: maior ? 'Informe vTroco ou ajuste os valores de pagamento.' : 'Confira os valores de pagamento (detPag/vPag).' },
      });
    }
  }
  const cobr = child(inf, 'cobr');
  if (cobr) {
    const fat = child(cobr, 'fat');
    const vOrig = num(child(fat, 'vOrig')), vDescF = num(child(fat, 'vDesc')) ?? 0, vLiq = num(child(fat, 'vLiq'));
    if (vOrig !== undefined && vLiq !== undefined) check({ node: child(fat, 'vLiq'), expected: vOrig - vDescF, sev: 'erro', code: '902', title: 'Valor líquido da fatura não fecha', how: `vOrig − vDesc = ${fmt2(r2(vOrig - vDescF))}` });
    const dups = childrenNamed(cobr, 'dup');
    const sDup = dups.reduce((s, d) => s + cents(num(child(d, 'vDup')) ?? 0), 0) / 100;
    if (dups.length && vLiq !== undefined && Math.abs(r2(sDup - vLiq)) >= 0.01) {
      // começa na parcela 002: a 001 foi paga na hora (entrada) e não vira duplicata
      const primeira = +(child(dups[0], 'nDup')?.text ?? '1');
      const semEntrada = primeira > 1 && sDup < vLiq;
      // MOC Y10-10 (obrigatória): a soma das duplicatas precisa ser igual ao líquido da fatura
      out.push({ sev: 'erro', origin: 'calculo', code: '851', title: 'Soma das duplicatas diferente do líquido da fatura', message: `Duplicatas somam ${brl(sDup)}, fatura líquida ${brl(vLiq)}.${semEntrada ? ` As duplicatas começam na parcela ${child(dups[0], 'nDup')!.text}: a diferença (${brl(r2(vLiq - sDup))}) parece ser uma entrada paga na hora, mas ela não pode ficar fora: o vLiq da fatura tem que ser igual à soma das duplicatas.` : ''}`, ...at(dups[0]), fix: { text: semEntrada ? 'Se a entrada foi paga à vista, a fatura (vOrig/vLiq) deve ter só o valor parcelado, ou a parcela da entrada entra como duplicata.' : 'Confira parcelas e arredondamento da última parcela.' } });
    }
    const dEmi = (child(ide, 'dhEmi')?.text ?? '').slice(0, 10);
    dups.forEach((d, i) => {
      const dv = child(d, 'dVenc')?.text, ant = i ? child(dups[i - 1], 'dVenc')?.text : undefined;
      if (dv && ant && dv < ant) out.push({ sev: 'erro', origin: 'regra', code: '850', title: 'Vencimento menor que o da parcela anterior', message: `A parcela ${child(d, 'nDup')?.text ?? i + 1} vence em ${dv}, antes da parcela anterior (${ant}). As duplicatas precisam estar em ordem de vencimento.`, ...at(child(d, 'dVenc')), found: dv, fix: { text: 'Ordene as parcelas pela data de vencimento.' } });
    });
    for (const d of dups) {
      const dv = child(d, 'dVenc');
      if (dv?.text && dEmi && dv.text < dEmi) out.push({ sev: 'erro', origin: 'regra', code: '900', title: 'Duplicata com vencimento anterior à emissão', message: `Vencimento ${dv.text} é anterior à data de emissão ${dEmi}.`, ...at(dv), found: dv.text, fix: { text: 'Confira a data de vencimento da parcela.' } });
    }
  }
  const transp = child(inf, 'transp');
  const vols = childrenNamed(transp, 'vol');
  const plTotal = vols.reduce((a, v) => a + (num(child(v, 'pesoL')) ?? 0), 0);
  for (const vol of vols) {
    const pl = num(child(vol, 'pesoL')), pb = num(child(vol, 'pesoB'));
    if (pl !== undefined && pb !== undefined && pb < pl) out.push({ sev: 'aviso', origin: 'regra', title: 'Peso bruto menor que o líquido', message: `pesoB (${pb}) é menor que pesoL (${pl}). O peso bruto inclui embalagem.`, ...at(child(vol, 'pesoB')), found: String(pb), fix: { text: 'Confira se os campos não foram invertidos.' } });
  }
  // escala: produtos em KG x peso líquido de todos os volumes
  {
    const kg = dets.filter((d) => /^(KG|KGS|KILO|KILOS|QUILO)$/i.test(select(d, 'prod/uCom')?.text ?? '')).reduce((s, d) => s + (num(select(d, 'prod/qCom')) ?? 0), 0);
    const first = vols.find((v) => num(child(v, 'pesoL')));
    if (kg > 0 && plTotal > 0 && first) {
      const ratio = plTotal / kg;
      if (ratio >= 500 || ratio <= 1 / 500) out.push({ sev: 'aviso', origin: 'regra', title: 'Peso líquido fora de escala', message: `Os itens em KG somam ${kg.toLocaleString('pt-BR')} kg, mas o peso líquido ${vols.length > 1 ? 'dos volumes soma' : 'é'} ${plTotal.toLocaleString('pt-BR')}. A diferença de ~${ratio > 1 ? Math.round(ratio) : Math.round(1 / ratio)}× sugere erro de unidade (kg × t ou ×1000).`, ...at(child(first, 'pesoL')), found: String(plTotal), fix: { text: 'Confira a unidade do peso na geração da nota.' } });
    }
  }

  /* ---------- texto duplicado nas informações complementares ---------- */
  const infCpl = select(inf, 'infAdic/infCpl');
  if (infCpl?.text && infCpl.text.length > 40) {
    const frases = infCpl.text.split(/[;.|]\s*/).map((s) => s.trim()).filter((s) => s.length > 20);
    const dup = frases.find((f, i) => frases.indexOf(f) !== i);
    if (dup) out.push({ sev: 'info', origin: 'regra', title: 'Texto repetido em infCpl', message: `O trecho "${dup.slice(0, 80)}${dup.length > 80 ? '...' : ''}" aparece mais de uma vez nas informações complementares.`, ...at(infCpl), fix: { text: 'Normalmente é a mesma observação vinda de dois cadastros (cliente e operação, por exemplo).' } });
  }

  return out;
}
