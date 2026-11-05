import type { Finding, XNode } from '../types';
import type { RuleCtx } from './nfe';
import { attr, child, childrenNamed, select, humanPath } from '../xml/parse';

/**
 * Regras de validação do MOC (Anexo I – Leiaute e Regras de Validação da NF-e e da NFC-e),
 * com o código de rejeição oficial. Só entram regras que se conferem com o próprio XML
 * (nada que dependa de cadastro da SEFAZ). Regra "Obrig." vira erro; regra "Facul."
 * (aplicação a critério da UF) vira aviso.
 * Cada regra traz o ID do MOC no comentário (ex.: E04-20) para conferência.
 */

const UF_SIGLA_COD: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26',
  AL: '27', SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};
const UF_CODES = new Set(Object.values(UF_SIGLA_COD));

/** CNPJ numérico ou alfanumérico (2026): DV módulo 11 sobre (código do caractere − 48). */
export function cnpjOk(v: string): boolean {
  const s = v.toUpperCase();
  if (!/^[0-9A-Z]{12}\d{2}$/.test(s) || /^0+$/.test(s)) return false;
  const dv = (base: string) => {
    let w = 2, sum = 0;
    for (let i = base.length - 1; i >= 0; i--) { sum += (base.charCodeAt(i) - 48) * w; w = w === 9 ? 2 : w + 1; }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(s.slice(0, 12));
  const d2 = dv(s.slice(0, 12) + d1);
  return s.slice(12) === `${d1}${d2}`;
}
export function cpfOk(v: string): boolean {
  if (!/^\d{11}$/.test(v) || /^(\d)\1{10}$/.test(v)) return false;
  const dv = (base: string) => {
    const sum = [...base].reduce((a, c, i) => a + +c * (base.length + 1 - i), 0) % 11;
    return sum < 2 ? 0 : 11 - sum;
  };
  const d1 = dv(v.slice(0, 9));
  return v.slice(9) === `${d1}${dv(v.slice(0, 9) + d1)}`;
}
/** GTIN-8/12/13/14: dígito módulo 10 com pesos 3/1 a partir da direita. */
export function gtinOk(v: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(v)) return false;
  const body = v.slice(0, -1);
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += +body[i] * w;
  return (10 - (sum % 10)) % 10 === +v.slice(-1);
}

const num = (n: XNode | undefined) => (n?.text !== undefined && /^-?\d+(\.\d+)?$/.test(n.text.trim()) ? Number(n.text) : undefined);
const SUL_SUDESTE = new Set(['RS', 'SC', 'PR', 'SP', 'RJ', 'MG']);

export function runMocRules(nfe: XNode, ctx: RuleCtx): Finding[] {
  const out: Finding[] = [];
  const inf = child(nfe, 'infNFe');
  if (!inf) return out;
  const ide = child(inf, 'ide'), emit = child(inf, 'emit'), dest = child(inf, 'dest');
  const dets = childrenNamed(inf, 'det');
  const g = (n: XNode | undefined, t: string) => child(n, t)?.text?.trim();
  const mod = g(ide, 'mod'), tpNF = g(ide, 'tpNF'), idDest = g(ide, 'idDest'), fin = g(ide, 'finNFe') ?? '1';
  const tpAmb = g(ide, 'tpAmb'), indFinal = g(ide, 'indFinal'), indPres = g(ide, 'indPres');
  const indIEDest = g(dest, 'indIEDest');
  const ufEmit = select(emit, 'enderEmit/UF')?.text, ufDest = select(dest, 'enderDest/UF')?.text;
  const crt = g(emit, 'CRT');
  const at = (n: XNode | undefined) => ({ path: n ? humanPath(n) : undefined, line: ctx.lineOf(n), tx2Field: ctx.fieldOf(n) });
  const item = (d: XNode) => `item ${attr(d, 'nItem') ?? dets.indexOf(d) + 1}`;
  const icms = (d: XNode) => select(d, 'imposto/ICMS')?.children[0];
  const add = (f: Omit<Finding, 'origin'> & { origin?: Finding['origin'] }) => out.push({ origin: 'regra', ...f } as Finding);
  const isNFCe = mod === '65';

  /* ---------- CNPJ / CPF (dígito verificador) ---------- */
  const docRules: [string, string, string, 'erro' | 'aviso', string][] = [
    // caminho a partir de infNFe, tag, código, severidade, descrição
    ['emit', 'CNPJ', '207', 'erro', 'CNPJ do emitente'],
    ['emit', 'CPF', '401', 'erro', 'CPF do emitente'],
    ['dest', 'CNPJ', '208', 'erro', 'CNPJ do destinatário'],
    ['dest', 'CPF', '237', 'erro', 'CPF do destinatário'],
    ['retirada', 'CNPJ', '512', 'aviso', 'CNPJ do local de retirada'],
    ['retirada', 'CPF', '540', 'aviso', 'CPF do local de retirada'],
    ['entrega', 'CNPJ', '514', 'aviso', 'CNPJ do local de entrega'],
    ['entrega', 'CPF', '541', 'aviso', 'CPF do local de entrega'],
    ['autXML', 'CNPJ', '323', 'erro', 'CNPJ autorizado a baixar o XML'],
    ['autXML', 'CPF', '325', 'erro', 'CPF autorizado a baixar o XML'],
    ['transp/transporta', 'CNPJ', '542', 'erro', 'CNPJ do transportador'],
    ['transp/transporta', 'CPF', '543', 'erro', 'CPF do transportador'],
    ['infIntermed', 'CNPJ', '440', 'erro', 'CNPJ do intermediador'],
  ];
  for (const [path, tag, code, sev, desc] of docRules) {
    const groups = path.includes('/') ? [select(inf, path)] : childrenNamed(inf, path);
    for (const grp of groups) {
      const n = child(grp, tag);
      const v = n?.text?.trim();
      if (!n || !v || (tag === 'CNPJ' && !/^[0-9A-Z]{12}\d{2}$/i.test(v)) || (tag === 'CPF' && !/^\d{11}$/.test(v))) continue; // formato: o schema acusa
      if (tag === 'CNPJ' ? cnpjOk(v) : cpfOk(v)) continue;
      add({ sev, code, title: `${desc} com dígito verificador inválido`, message: `${v} não fecha no dígito verificador${/^(\d)\1+$/.test(v) ? ' (todos os dígitos iguais)' : ''}. Normalmente é erro de digitação no cadastro.`, ...at(n), found: v, fix: { text: 'Corrija o documento no cadastro e gere a nota de novo.' } });
    }
  }
  for (const d of dets) {
    const n = select(d, 'prod/CNPJFab');
    if (n?.text && /^[0-9A-Z]{12}\d{2}$/i.test(n.text) && !cnpjOk(n.text)) add({ sev: 'erro', code: '489', title: `CNPJ do fabricante inválido (${item(d)})`, message: `${n.text} não fecha no dígito verificador.`, ...at(n), found: n.text });
  }
  for (const r of childrenNamed(ide, 'NFref')) {
    const p = child(r, 'refNFP');
    if (!p) continue;
    const c = child(p, 'CNPJ'), f = child(p, 'CPF');
    if (c?.text && /^\d{14}$/.test(c.text) && !cnpjOk(c.text)) add({ sev: 'aviso', code: '549', title: 'CNPJ da nota de produtor referenciada inválido', message: `${c.text} não fecha no dígito verificador.`, ...at(c), found: c.text });
    if (f?.text && /^\d{11}$/.test(f.text) && !cpfOk(f.text)) add({ sev: 'aviso', code: '550', title: 'CPF da nota de produtor referenciada inválido', message: `${f.text} não fecha no dígito verificador.`, ...at(f), found: f.text });
  }

  /* ---------- documentos referenciados (BA) ---------- */
  const refs = childrenNamed(ide, 'NFref');
  const keys = refs.map((r) => child(r, 'refNFe')).filter((n): n is XNode => !!n?.text);
  const year2 = +String((ctx.now ?? new Date()).getFullYear()).slice(2);
  const seenKeys = new Map<string, XNode>();
  for (const k of keys) {
    const v = k.text!.trim();
    if (!/^\d{6}[0-9A-Z]{12}\d{26}$/.test(v)) continue;
    const prob: [string, string][] = [];
    if (!UF_CODES.has(v.slice(0, 2))) prob.push(['522', `código de UF ${v.slice(0, 2)} inexistente`]);
    const aa = +v.slice(2, 4), mm = +v.slice(4, 6);
    if (aa < 6 || aa > year2 || mm < 1 || mm > 12) prob.push(['524', `ano/mês de emissão ${v.slice(2, 6)} inválido`]);
    if (!['55', '65', '59'].includes(v.slice(20, 22))) prob.push(['679', `modelo ${v.slice(20, 22)} (precisa ser 55, 65 ou 59)`]);
    if (/^0+$/.test(v.slice(25, 34))) prob.push(['683', 'número da nota zerado']);
    for (const [code, what] of prob) add({ sev: 'aviso', code, title: 'Chave referenciada inconsistente', message: `A chave ${v} tem ${what}.`, ...at(k), found: v, fix: { text: 'Copie a chave de novo do XML ou do DANFE da nota original.' } });
    if (seenKeys.has(v)) add({ sev: 'aviso', code: '680', title: 'Chave referenciada repetida', message: `A chave ${v} foi referenciada mais de uma vez.`, ...at(k), found: v, fix: { text: 'Deixe só uma ocorrência.' } });
    seenKeys.set(v, k);
  }
  // B25-30 / B25-40: complementar precisa de exatamente uma referência
  if (fin === '2' && mod === '55') {
    const docs = refs.filter((r) => child(r, 'refNFe') || child(r, 'refNF'));
    if (!refs.length) add({ sev: 'erro', code: '254', title: 'NF-e complementar sem nota referenciada', message: 'A nota é complementar (finNFe=2), mas não referencia a nota que está sendo complementada.', ...at(child(ide, 'finNFe')), fix: { text: 'Inclua a chave da nota original (refNFe_BA02 no TX2).' } });
    else if (docs.length > 1) add({ sev: 'erro', code: '255', title: 'NF-e complementar com mais de uma nota referenciada', message: `A nota complementar referencia ${docs.length} notas; só pode referenciar uma.`, ...at(docs[1]), fix: { text: 'Emita uma complementar para cada nota original.' } });
  }
  // I08-184 / I08-190: CFOP de cupom fiscal ou exportação indireta sem referência
  if (!refs.length && mod === '55') {
    const d = dets.find((x) => ['5929', '6929', '3503', '7501'].includes(select(x, 'prod/CFOP')?.text ?? ''));
    if (d) add({ sev: 'erro', code: '701', title: `CFOP ${select(d, 'prod/CFOP')!.text} sem documento referenciado`, message: 'Lançamento relativo a cupom fiscal (5.929/6.929) ou exportação indireta (3.503/7.501) precisa referenciar o documento de origem (NFref).', ...at(select(d, 'prod/CFOP')), fix: { text: 'Inclua a referência ao cupom ou à nota de origem.' } });
  }

  /* ---------- identificação (B) ---------- */
  const cNF = g(ide, 'cNF'), nNF = g(ide, 'nNF');
  if (cNF && /^\d{8}$/.test(cNF)) {
    const seq = '01234567890123456789';
    const ruim = /^(\d)\1{7}$/.test(cNF) || seq.includes(cNF) || (nNF !== undefined && +cNF === +nNF);
    if (ruim) add({ sev: 'erro', code: '897', title: 'Código numérico (cNF) não aceito', message: `cNF ${cNF} ${nNF !== undefined && +cNF === +nNF ? 'é igual ao número da nota' : 'é uma sequência repetida ou crescente'}, e a SEFAZ não aceita (proteção da chave de acesso).`, ...at(child(ide, 'cNF')), found: cNF, fix: { text: 'O cNF deve ser um número aleatório de 8 dígitos, diferente do número da nota. Mudar o cNF muda a chave: gere a nota de novo.' } });
  }
  const cUF = g(ide, 'cUF');
  const cMunFG = child(ide, 'cMunFG');
  if (cUF && cMunFG?.text && /^\d{7}$/.test(cMunFG.text) && cMunFG.text.slice(0, 2) !== cUF) add({ sev: 'erro', code: '271', title: 'Município do fato gerador de outra UF', message: `cMunFG ${cMunFG.text} começa com ${cMunFG.text.slice(0, 2)}, mas a UF da nota (cUF) é ${cUF}.`, ...at(cMunFG), found: cMunFG.text, fix: { text: 'Use o código IBGE do município do emitente.' } });
  const cMunE = select(emit, 'enderEmit/cMun');
  if (cUF && cMunE?.text && /^\d{7}$/.test(cMunE.text) && cMunE.text.slice(0, 2) !== cUF) add({ sev: 'erro', code: '273', title: 'Município do emitente de outra UF', message: `O código IBGE ${cMunE.text} começa com ${cMunE.text.slice(0, 2)}, diferente do cUF ${cUF}.`, ...at(cMunE), found: cMunE.text, fix: { text: 'Corrija o município no cadastro da empresa.' } });
  const munUf: [XNode | undefined, string | undefined, string, string][] = [
    [select(dest, 'enderDest/cMun'), ufDest, '275', 'destinatário'],
    [select(inf, 'retirada/cMun'), select(inf, 'retirada/UF')?.text, '277', 'local de retirada'],
    [select(inf, 'entrega/cMun'), select(inf, 'entrega/UF')?.text, '279', 'local de entrega'],
  ];
  for (const [n, uf, code, who] of munUf) {
    if (!n?.text || !uf || uf === 'EX' || !/^\d{7}$/.test(n.text) || !UF_SIGLA_COD[uf]) continue;
    if (n.text.slice(0, 2) !== UF_SIGLA_COD[uf]) add({ sev: 'erro', code, title: `Município do ${who} não é da UF informada`, message: `O código IBGE ${n.text} é da UF ${n.text.slice(0, 2)}, mas a UF informada é ${uf} (${UF_SIGLA_COD[uf]}).`, ...at(n), found: n.text, fix: { text: 'Corrija o município ou a UF no cadastro.' } });
  }
  const tpEmis = g(ide, 'tpEmis'), tpImp = g(ide, 'tpImp');
  if (tpEmis === '1' && (child(ide, 'dhCont') || child(ide, 'xJust'))) add({ sev: 'erro', code: '556', title: 'Dados de contingência em emissão normal', message: 'Com tpEmis=1 (normal) não se informa dhCont nem xJust.', ...at(child(ide, 'dhCont') ?? child(ide, 'xJust')), fix: { text: 'Remova dhCont e xJust, ou use o tpEmis da contingência.' } });
  if (mod === '55' && (tpImp === '4' || tpImp === '5')) add({ sev: 'erro', code: '710', title: 'NF-e com tipo de impressão de NFC-e', message: `tpImp=${tpImp} é DANFE NFC-e; a NF-e usa 0, 1, 2 ou 3.`, ...at(child(ide, 'tpImp')), found: tpImp, fix: { text: 'Use tpImp=1 (retrato) ou 2 (paisagem).', value: '1' } });
  if (isNFCe && tpImp && !['4', '5'].includes(tpImp)) add({ sev: 'erro', code: '709', title: 'NFC-e com tipo de impressão inválido', message: `NFC-e aceita só tpImp 4 (DANFE NFC-e) ou 5 (mensagem eletrônica); veio ${tpImp}.`, ...at(child(ide, 'tpImp')), found: tpImp, fix: { text: 'Use tpImp=4.', value: '4' } });
  // B25c-10: venda não presencial exige o indicador de intermediador
  if (indPres && ['2', '3', '4', '9'].includes(indPres) && !child(ide, 'indIntermed')) add({ sev: 'erro', code: '434', title: 'Falta o indicador de intermediador (indIntermed)', message: `Com indPres=${indPres} (operação não presencial) é obrigatório informar indIntermed (0 = sem intermediador, 1 = site/plataforma de terceiros).`, ...at(child(ide, 'indPres')), fix: { text: 'Informe indIntermed (no TX2, indIntermed_B25c).' } });
  const indIntermed = g(ide, 'indIntermed');
  if (indIntermed === '1' && !child(inf, 'infIntermed')) add({ sev: 'erro', code: '438', title: 'Venda por intermediador sem os dados do intermediador', message: 'indIntermed=1 (marketplace) exige o grupo infIntermed (CNPJ e identificador do intermediador).', ...at(child(ide, 'indIntermed')), fix: { text: 'Informe o grupo infIntermed ou use indIntermed=0.' } });
  if (child(inf, 'infIntermed') && indIntermed !== '1') add({ sev: 'erro', code: '439', title: 'Dados de intermediador sem venda por intermediador', message: 'O grupo infIntermed só pode ser informado com indIntermed=1.', ...at(child(inf, 'infIntermed')), fix: { text: 'Remova o grupo infIntermed ou use indIntermed=1.' } });

  /* ---------- destinatário (E) ---------- */
  if (mod === '55' && !dest) add({ sev: 'erro', code: '719', title: 'NF-e sem destinatário', message: 'A NF-e (modelo 55) precisa do grupo dest.', ...at(ide), fix: { text: 'Informe o destinatário.' } });
  if (dest && tpAmb === '2') {
    const xn = child(dest, 'xNome');
    const LIT = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
    if (xn?.text !== undefined && xn.text.trim() !== LIT) add({ sev: 'erro', code: '598', title: 'Nome do destinatário em homologação', message: 'Em homologação (tpAmb=2) o nome do destinatário precisa ser exatamente o texto padrão da SEFAZ.', ...at(xn), found: xn.text, expected: LIT, fix: { text: 'Texto exigido em homologação.', value: LIT } });
  }
  if (dest && mod === '55') {
    const ie = child(dest, 'IE');
    if (indIEDest === '1' && !ie?.text) add({ sev: 'erro', code: '728', title: 'Destinatário contribuinte sem IE', message: 'indIEDest=1 (contribuinte) exige a inscrição estadual do destinatário.', ...at(child(dest, 'indIEDest')), fix: { text: 'Informe a IE ou corrija o indicador (2 = isento de IE, 9 = não contribuinte).' } });
    if (indIEDest === '2' && ie?.text) add({ sev: 'erro', code: '791', title: 'Destinatário isento de IE com IE informada', message: 'indIEDest=2 (isento de inscrição) não pode ter IE informada.', ...at(ie), found: ie.text, fix: { text: 'Remova a IE ou use indIEDest=1.' } });
    if (idDest === '3' && indIEDest && indIEDest !== '9') add({ sev: 'erro', code: '790', title: 'Destinatário do exterior não marcado como não contribuinte', message: 'Em operação com o exterior (idDest=3) o indIEDest tem que ser 9.', ...at(child(dest, 'indIEDest')), found: indIEDest, fix: { text: 'Use indIEDest=9.', value: '9' } });
    if (idDest === '3' && !child(dest, 'idEstrangeiro')) add({ sev: 'erro', code: '720', title: 'Operação com o exterior sem idEstrangeiro', message: 'Com idDest=3 a tag idEstrangeiro é obrigatória (pode ser vazia).', ...at(dest), fix: { text: 'Informe idEstrangeiro (documento do estrangeiro, ou vazio).' } });
    if (child(dest, 'idEstrangeiro') && ie?.text) add({ sev: 'erro', code: '925', title: 'Destinatário estrangeiro com IE', message: 'Com idEstrangeiro informado não pode haver IE do destinatário.', ...at(ie), found: ie.text, fix: { text: 'Remova a IE.' } });
  }

  /* ---------- NFC-e (modelo 65) ---------- */
  if (isNFCe) {
    const nfce: [boolean, string, string, XNode | undefined][] = [
      [!!child(ide, 'dhSaiEnt'), '705', 'NFC-e não tem data de saída (dhSaiEnt)', child(ide, 'dhSaiEnt')],
      [tpNF === '0', '706', 'NFC-e não pode ser de entrada (tpNF=0)', child(ide, 'tpNF')],
      [!!idDest && idDest !== '1', '707', 'NFC-e só pode ser operação interna (idDest=1)', child(ide, 'idDest')],
      [fin !== '1', '715', 'NFC-e só pode ter finalidade normal (finNFe=1)', child(ide, 'finNFe')],
      [indFinal === '0', '716', 'NFC-e só pode ser para consumidor final (indFinal=1)', child(ide, 'indFinal')],
      [!!indPres && !['1', '4'].includes(indPres), '717', 'NFC-e só em operação presencial ou entrega a domicílio (indPres 1 ou 4)', child(ide, 'indPres')],
      [refs.length > 0, '708', 'NFC-e não pode referenciar outros documentos (NFref)', refs[0]],
      [!!child(emit, 'IEST'), '718', 'NFC-e não pode ter IE de substituto tributário (IEST)', child(emit, 'IEST')],
      [!!dest && !!indIEDest && indIEDest !== '9', '789', 'Destinatário da NFC-e tem que ser não contribuinte (indIEDest=9)', child(dest, 'indIEDest')],
      [!!child(dest, 'ISUF'), '730', 'NFC-e não pode ter inscrição Suframa do destinatário', child(dest, 'ISUF')],
      [!!child(inf, 'cobr'), '760', 'NFC-e não pode ter dados de cobrança (fatura/duplicata)', child(inf, 'cobr')],
      [!!child(inf, 'exporta'), '814', 'NFC-e não pode ter grupo de exportação', child(inf, 'exporta')],
      [!!child(inf, 'compra'), '762', 'NFC-e não pode ter dados de compra (empenho, pedido, contrato)', child(inf, 'compra')],
      [!!child(inf, 'cana'), '763', 'NFC-e não pode ter dados de aquisição de cana', child(inf, 'cana')],
      [g(child(inf, 'transp'), 'modFrete') !== undefined && g(child(inf, 'transp'), 'modFrete') !== '9' && indPres !== '4', '753', 'NFC-e com frete sem ser entrega a domicílio (modFrete precisa ser 9)', select(inf, 'transp/modFrete')],
      [!!select(inf, 'transp/transporta') && indPres !== '4', '754', 'NFC-e com transportador sem ser entrega a domicílio', select(inf, 'transp/transporta')],
      [!!select(inf, 'transp/veicTransp'), '756', 'NFC-e não pode ter veículo de transporte', select(inf, 'transp/veicTransp')],
      [!!select(inf, 'transp/reboque'), '757', 'NFC-e não pode ter reboque', select(inf, 'transp/reboque')],
    ];
    for (const [cond, code, title, n] of nfce) if (cond) add({ sev: 'erro', code, title, message: `${title}.`, ...at(n ?? ide), found: n?.text, fix: { text: 'Remova o campo/grupo ou emita como NF-e (modelo 55).' } });
    for (const d of dets) {
      const per: [boolean, string, string, XNode | undefined][] = [
        [!!select(d, 'imposto/IPI'), '742', 'NFC-e não pode ter IPI', select(d, 'imposto/IPI')],
        [!!select(d, 'imposto/II'), '743', 'NFC-e não pode ter imposto de importação', select(d, 'imposto/II')],
        [!!select(d, 'imposto/ICMSUFDest'), '807', 'NFC-e não pode ter ICMS para a UF de destino', select(d, 'imposto/ICMSUFDest')],
        [!!child(d, 'impostoDevol'), '390', 'NFC-e não pode ter grupo de tributos devolvidos', child(d, 'impostoDevol')],
        [!!select(d, 'prod/veicProd'), '736', 'NFC-e não pode ter veículo novo', select(d, 'prod/veicProd')],
        [select(d, 'prod/indTot')?.text === '0', '774', 'Item de NFC-e tem que compor o total (indTot=1)', select(d, 'prod/indTot')],
      ];
      for (const [cond, code, title, n] of per) if (cond) add({ sev: 'erro', code, title: `${title} (${item(d)})`, message: `${title}.`, ...at(n), fix: { text: 'Remova o grupo ou emita como NF-e (modelo 55).' } });
    }
    for (const p of childrenNamed(child(inf, 'pag'), 'detPag')) {
      const t = child(p, 'tPag');
      if (t?.text === '14') add({ sev: 'erro', code: '857', title: 'Duplicata mercantil como forma de pagamento na NFC-e', message: 'tPag=14 (duplicata mercantil) não é aceito na NFC-e.', ...at(t), found: t.text });
      if (t?.text === '90') add({ sev: 'erro', code: '899', title: 'NFC-e sem pagamento (tPag=90)', message: 'A NFC-e não aceita tPag=90.', ...at(t), found: t.text });
    }
  }

  /* ---------- itens (I, N, U) ---------- */
  dets.forEach((d, i) => {
    const n = attr(d, 'nItem');
    if (n && +n !== i + 1) add({ sev: 'erro', code: '927', title: 'Número do item fora de sequência', message: `O ${i + 1}º item está com nItem=${n}. Os itens precisam ser numerados 1, 2, 3... sem pular.`, ...at(d), found: n, expected: String(i + 1), fix: { text: 'Renumere os itens.', value: String(i + 1) } });
  });
  for (const d of dets) {
    const prod = child(d, 'prod');
    const lbl = item(d);
    // GTIN (I03-10, I12-10, I12-30, I12-40, I03-30, I12-60)
    const ean = child(prod, 'cEAN'), eanT = child(prod, 'cEANTrib');
    const real = (x?: XNode) => !!x?.text && x.text.trim() !== '' && x.text.trim().toUpperCase() !== 'SEM GTIN';
    if (ean && (ean.text ?? '').trim() === '') add({ sev: 'erro', code: '883', title: `cEAN vazio (${lbl})`, message: 'Produto sem código de barras deve ter cEAN = "SEM GTIN".', ...at(ean), found: '(vazio)', fix: { text: 'Use SEM GTIN.', value: 'SEM GTIN' } });
    if (eanT && (eanT.text ?? '').trim() === '') add({ sev: 'erro', code: '888', title: `cEANTrib vazio (${lbl})`, message: 'Produto sem código de barras deve ter cEANTrib = "SEM GTIN".', ...at(eanT), found: '(vazio)', fix: { text: 'Use SEM GTIN.', value: 'SEM GTIN' } });
    if (real(ean) && /^\d+$/.test(ean!.text!) && !gtinOk(ean!.text!)) add({ sev: 'erro', code: '611', title: `GTIN (cEAN) com dígito verificador inválido (${lbl})`, message: `${ean!.text} não fecha no dígito do código de barras.`, ...at(ean), found: ean!.text, fix: { text: 'Corrija o código de barras no cadastro do produto ou use SEM GTIN.' } });
    if (real(eanT) && /^\d+$/.test(eanT!.text!) && !gtinOk(eanT!.text!)) add({ sev: 'erro', code: '612', title: `GTIN tributável (cEANTrib) com dígito verificador inválido (${lbl})`, message: `${eanT!.text} não fecha no dígito do código de barras.`, ...at(eanT), found: eanT!.text, fix: { text: 'Corrija o código de barras no cadastro do produto ou use SEM GTIN.' } });
    if (real(ean) && eanT && !real(eanT)) add({ sev: 'erro', code: '885', title: `GTIN informado e GTIN tributável SEM GTIN (${lbl})`, message: 'Com cEAN preenchido, o cEANTrib também precisa ter o GTIN (o da unidade tributável).', ...at(eanT), found: eanT.text, fix: { text: 'Informe o GTIN da unidade tributável (geralmente igual ao cEAN).', value: ean!.text } });
    if (real(eanT) && ean && !real(ean)) add({ sev: 'erro', code: '886', title: `GTIN tributável informado e GTIN SEM GTIN (${lbl})`, message: 'Com cEANTrib preenchido, o cEAN também precisa ter o GTIN.', ...at(ean), found: ean.text, fix: { text: 'Informe o GTIN no cEAN.', value: eanT!.text } });
    // NCM completo (I05-10)
    const ncm = child(prod, 'NCM');
    if (ncm?.text && /^\d{2}$/.test(ncm.text) && ncm.text !== '00') add({ sev: 'erro', code: '777', title: `NCM incompleto (${lbl})`, message: `NCM ${ncm.text} tem só 2 dígitos. Informe o NCM completo (8 dígitos); "00" só para item de serviço ou sem produto.`, ...at(ncm), found: ncm.text, fix: { text: 'Corrija o NCM no cadastro do produto.' } });
    // desconto maior que o produto (I17-10)
    const vD = num(child(prod, 'vDesc')), vP = num(child(prod, 'vProd'));
    if (vD !== undefined && vP !== undefined && vD > vP + 0.001) add({ sev: 'erro', code: '483', title: `Desconto maior que o valor do produto (${lbl})`, message: `vDesc ${vD.toFixed(2)} é maior que vProd ${vP.toFixed(2)}.`, ...at(child(prod, 'vDesc')), found: child(prod, 'vDesc')!.text });
    // tributos devolvidos fora de devolução (UA01-10)
    if (child(d, 'impostoDevol') && fin !== '4') add({ sev: 'erro', code: '354', title: `Tributos devolvidos em nota que não é de devolução (${lbl})`, message: 'O grupo impostoDevol só pode ser usado com finNFe=4.', ...at(child(d, 'impostoDevol')), fix: { text: 'Remova o grupo impostoDevol ou corrija a finalidade.' } });
    // IPI devolvido no grupo do IPI e no impostoDevol ao mesmo tempo: o total de IPI e o vNF não fecham juntos
    const vIpiItem = num(select(d, 'imposto/IPI/IPITrib/vIPI')), vIpiDev = num(select(d, 'impostoDevol/IPI/vIPIDevol'));
    if (fin === '4' && (vIpiItem ?? 0) > 0 && (vIpiDev ?? 0) > 0) add({ sev: 'aviso', title: `IPI devolvido informado duas vezes (${lbl})`, message: `O item tem vIPI ${vIpiItem!.toFixed(2)} no grupo IPI e vIPIDevol ${vIpiDev!.toFixed(2)} no impostoDevol. Na devolução o IPI devolvido vai só em vIPIDevol (que entra no total vIPIDevol); com os dois, ou o total vIPI não fecha com os itens (538) ou o IPI é somado duas vezes no vNF.`, ...at(select(d, 'imposto/IPI/IPITrib/vIPI')), found: select(d, 'imposto/IPI/IPITrib/vIPI')!.text, fix: { text: 'Confira com a tributação da devolução: normalmente o IPI devolvido fica só no vIPIDevol_U61 (impostoDevol).' } });
    // exportação (I50-10)
    if (select(prod, 'detExport') && idDest !== '3') add({ sev: 'erro', code: '336', title: `Grupo de exportação em operação que não é com o exterior (${lbl})`, message: 'detExport só pode ser informado com idDest=3.', ...at(select(prod, 'detExport')), fix: { text: 'Remova detExport ou corrija o idDest.' } });

    const gI = icms(d);
    if (!gI) continue;
    const cst = g(gI, 'CST'), csosn = g(gI, 'CSOSN');
    // CST x CRT (N12-20, N12a-10): Simples (CRT 1 e MEI CRT 4) usa CSOSN
    if (crt && cst && ['1', '4'].includes(crt)) add({ sev: 'aviso', code: '590', title: `CST informado para emitente do Simples (${lbl})`, message: `CRT=${crt} usa CSOSN, não CST ${cst}.`, ...at(child(gI, 'CST')), found: cst, fix: { text: 'Confira o regime tributário do emitente (CRT) ou a tributação do produto.' } });
    if (crt && csosn && !['1', '4'].includes(crt)) add({ sev: 'aviso', code: '591', title: `CSOSN informado para emitente fora do Simples (${lbl})`, message: `CRT=${crt} usa CST, não CSOSN ${csosn}.`, ...at(child(gI, 'CSOSN')), found: csosn, fix: { text: 'Confira o regime tributário do emitente (CRT) ou a tributação do produto.' } });
    // CEST obrigatório com ST (N23-10)
    const comST = ['10', '30', '60', '70'].includes(cst ?? '') || ['201', '202', '203', '500'].includes(csosn ?? '') || ((cst === '90' || csosn === '900') && (num(child(gI, 'vICMSST')) ?? 0) > 0);
    if (mod === '55' && comST && !child(prod, 'CEST')) add({ sev: 'erro', code: '806', title: `Falta o CEST em item com substituição tributária (${lbl})`, message: `${cst ? 'CST ' + cst : 'CSOSN ' + csosn} tem ICMS ST e exige o CEST do produto.`, ...at(child(gI, cst ? 'CST' : 'CSOSN')), fix: { text: 'Cadastre o CEST no produto (no TX2, CEST_I05c depois do NCM).' } });
    // FCP com percentual zero (N17b-10, N23b-10, N27b-10)
    for (const [t, code] of [['pFCP', '880'], ['pFCPST', '881'], ['pFCPSTRet', '881']] as const) {
      const n = child(gI, t);
      if (n && num(n) === 0) add({ sev: 'erro', code, title: `${t} zerado (${lbl})`, message: `Não informe os campos de FCP quando o produto não tem FCP: ${t} = 0 é rejeitado.`, ...at(n), found: n.text, fix: { text: `Remova os campos de FCP do grupo (${t} e os valores correspondentes).` } });
    }
    // MVA x modalidade (N18-10, N18-20)
    const modST = g(gI, 'modBCST');
    if (modST === '4' && child(gI, 'vBCST') && !child(gI, 'pMVAST')) add({ sev: 'aviso', code: '932', title: `ST por MVA sem pMVAST (${lbl})`, message: 'modBCST=4 (margem de valor agregado) exige pMVAST.', ...at(child(gI, 'modBCST')), fix: { text: 'Informe o percentual de MVA.' } });
    if (modST && modST !== '4' && child(gI, 'pMVAST')) add({ sev: 'aviso', code: '933', title: `pMVAST com modalidade de ST que não é MVA (${lbl})`, message: `modBCST=${modST} não usa MVA, mas pMVAST foi informado.`, ...at(child(gI, 'pMVAST')), fix: { text: 'Remova pMVAST ou use modBCST=4.' } });
    // desoneração sem valor (N28-30)
    if (child(gI, 'motDesICMS') && !((num(child(gI, 'vICMSDeson')) ?? 0) > 0)) add({ sev: 'aviso', code: '627', title: `Motivo de desoneração sem valor desonerado (${lbl})`, message: 'Com motDesICMS informado, vICMSDeson precisa ser maior que zero.', ...at(child(gI, 'motDesICMS')), fix: { text: 'Informe o valor desonerado ou remova o motivo.' } });
    // contribuinte isento de IE com CST 50/51 (N12-80)
    const cfop = select(prod, 'CFOP')?.text ?? '';
    if (mod === '55' && indIEDest === '2' && (cst === '50' || cst === '51') && !(cst === '50' && /^[1256]91[2356]$/.test(cfop) && !/^[26]91[23]$/.test(cfop))) {
      const critUF = cst === '51' && idDest === '1' && !!child(dest, 'CNPJ'); // exceção 3: a critério da UF
      add({ sev: critUF ? 'aviso' : 'erro', code: '529', title: `CST ${cst} com destinatário isento de IE (${lbl})`, message: `Com indIEDest=2 (contribuinte isento de inscrição) a SEFAZ rejeita CST 50 (suspensão) e 51 (diferimento), salvo CST 50 em conserto/reparo ou demonstração interna.${critUF ? ' Para CST 51 em operação interna com destinatário PJ algumas UFs aceitam.' : ''}`, ...at(child(gI, 'CST')), found: cst, fix: { text: 'Confira o indIEDest do cadastro do cliente antes de mudar a tributação.' } });
    }
    // Simples com não contribuinte (N12a-70)
    if (mod === '55' && indIEDest === '9' && tpNF === '1' && csosn && !['102', '103', '300', '400', '500'].includes(csosn) && !['5915', '5916', '6915', '6916', '5912', '5913'].includes(cfop)) add({ sev: 'erro', code: '600', title: `CSOSN ${csosn} com destinatário não contribuinte (${lbl})`, message: 'Com indIEDest=9 a SEFAZ aceita só CSOSN 102, 103, 300, 400 ou 500.', ...at(child(gI, 'CSOSN')), found: csosn, fix: { text: 'Confira o cadastro do cliente (IE) antes de mudar a tributação.' } });
    // alíquota interestadual (N16-20)
    const orig = g(gI, 'orig'), pICMS = num(child(gI, 'pICMS'));
    const ufEnt = select(inf, 'entrega/UF')?.text, ufRet = select(inf, 'retirada/UF')?.text;
    const exc693 = !!select(prod, 'veicProd') || ['6118', '6119', '6122', '6123'].includes(cfop) || (!!ufEnt && ufEnt !== ufEmit) || (!!ufRet && ufRet !== ufDest);
    if (mod === '55' && idDest === '2' && tpNF === '1' && fin === '1' && pICMS !== undefined && orig && !['1', '2', '3', '8'].includes(orig) && ufEmit && ufDest && !exc693) {
      const max = SUL_SUDESTE.has(ufEmit) && !SUL_SUDESTE.has(ufDest) ? 7 : 12;
      if (pICMS > max + 0.0001) add({ sev: 'aviso', code: '693', title: `Alíquota interestadual acima do limite (${lbl})`, message: `De ${ufEmit} para ${ufDest} a alíquota interestadual de produto nacional é no máximo ${max}%; veio ${pICMS}%.`, ...at(child(gI, 'pICMS')), found: child(gI, 'pICMS')!.text, expected: `até ${max}.00`, fix: { text: 'Confira a tributação interestadual do produto (CFOP de retorno ou anulação de valor não entram nesta regra).' } });
    }
    // partilha do ICMS (DIFAL) – NA01-20 / NA01-30
    const temUFDest = !!select(d, 'imposto/ICMSUFDest');
    const ufEnt2 = select(inf, 'entrega/UF')?.text;
    const isento = ['40', '41'].includes(cst ?? '') || ['103', '300', '400'].includes(csosn ?? '');
    const exige = idDest === '2' && indFinal === '1' && indIEDest === '9' && tpNF === '1' && fin === '1' && !['1', '4'].includes(crt ?? '') && !isento
      && !select(d, 'imposto/ISSQN') && !child(select(d, 'imposto/ICMS'), 'ICMSPart') && !select(prod, 'comb') && ufEnt2 !== ufEmit && !['6552', '6922', '6929'].includes(cfop);
    // NA01-20 tem exceções por tabela CFOP (remessa, retorno) que o validador não tem completas: aviso
    if (mod === '55' && exige && !temUFDest) add({ sev: 'aviso', code: '694', title: `Falta o ICMS da UF de destino (DIFAL) (${lbl})`, message: 'Venda interestadual para consumidor final não contribuinte exige o grupo ICMSUFDest em cada item.', ...at(select(d, 'imposto')), fix: { text: 'Gere o grupo ICMSUFDest (diferencial de alíquota) no item.' } });
    if (mod === '55' && temUFDest && !(idDest === '2' && indFinal === '1' && indIEDest === '9') && fin !== '4' && !(ufEnt2 && ufEnt2 !== ufEmit)) add({ sev: 'erro', code: '695', title: `ICMS da UF de destino informado indevidamente (${lbl})`, message: 'O grupo ICMSUFDest só vale para operação interestadual com consumidor final não contribuinte.', ...at(select(d, 'imposto/ICMSUFDest')), fix: { text: 'Remova o grupo ICMSUFDest.' } });
  }

  /* ---------- transporte, cobrança, pagamento (X, Y, YA) ---------- */
  const transp = child(inf, 'transp');
  if (mod === '55' && idDest === '2' && (child(transp, 'veicTransp') || child(transp, 'reboque'))) add({ sev: 'erro', code: '868', title: 'Veículo/reboque em operação interestadual', message: 'Em operação interestadual não se informam os grupos veicTransp e reboque (a placa vai no MDF-e).', ...at(child(transp, 'veicTransp') ?? child(transp, 'reboque')), fix: { text: 'Remova os dados do veículo e do reboque da nota.' } });
  if (child(inf, 'exporta') && (tpNF === '0' || idDest !== '3')) add({ sev: 'erro', code: '356', title: 'Grupo de exportação em operação que não é exportação', message: 'O grupo exporta só vale para saída (tpNF=1) com o exterior (idDest=3).', ...at(child(inf, 'exporta')), fix: { text: 'Remova o grupo exporta.' } });
  const fat = select(inf, 'cobr/fat');
  const vOrig = num(child(fat, 'vOrig')), vDescF = num(child(fat, 'vDesc'));
  if (vOrig !== undefined && vDescF !== undefined && vDescF > vOrig + 0.001) add({ sev: 'erro', code: '901', title: 'Desconto da fatura maior que o valor original', message: `vDesc ${vDescF.toFixed(2)} é maior que vOrig ${vOrig.toFixed(2)}.`, ...at(child(fat, 'vDesc')), found: child(fat, 'vDesc')!.text });
  const pag = child(inf, 'pag');
  const detPags = childrenNamed(pag, 'detPag');
  if ((fin === '3' || fin === '4') && mod === '55') {
    const t = detPags.map((p) => child(p, 'tPag')).find((x) => x?.text && x.text !== '90');
    if (t) add({ sev: 'erro', code: '871', title: `Forma de pagamento em nota de ${fin === '4' ? 'devolução' : 'ajuste'}`, message: `Nota de ${fin === '4' ? 'devolução' : 'ajuste'} (finNFe=${fin}) tem que usar tPag=90 (sem pagamento).`, ...at(t), found: t.text, fix: { text: 'Use tPag=90 e vPag=0.00.', value: '90' } });
  }
  for (const p of detPags) {
    const t = child(p, 'tPag'), v = child(p, 'vPag');
    if (t?.text === '90' && (num(v) ?? 0) !== 0) add({ sev: 'aviso', code: '904', title: 'Valor de pagamento com tPag=90 (sem pagamento)', message: `Sem pagamento (tPag=90) o vPag tem que ser 0.00; veio ${v!.text}.`, ...at(v), found: v!.text, fix: { text: 'Valor exigido para tPag=90.', value: '0.00' } });
  }
  return out;
}
