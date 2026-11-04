/**
 * Gerador de NF-e de teste com contas consistentes.
 *
 * Monta um modelo da nota (objeto aninhado com os nomes das tags) e serializa em
 * XML e em TX2 de forma independente do leitor de TX2 do validador. O XML gerado
 * é validado pelo XSD oficial nos testes, o que também confere o próprio gerador.
 */
import { nfeDict } from '../../src/core/engine-data';
import { dvChave } from '../../src/core/rules/nfe';

/* ------------------------------------------------------------------ */
/* Aleatoriedade reproduzível                                          */
/* ------------------------------------------------------------------ */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type R = ReturnType<typeof rng>;

/* ------------------------------------------------------------------ */
/* Modelo                                                              */
/* ------------------------------------------------------------------ */
/** Nó do modelo: texto (folha), objeto (grupo) ou lista (repetição). Chaves "@x" são atributos. */
export type MNode = string | { [k: string]: MNode | MNode[] | undefined };
export type MGroup = { [k: string]: MNode | MNode[] | undefined };

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const f2 = (v: number) => r2(v).toFixed(2);
const f4 = (v: number) => v.toFixed(4);

export interface ItemInfo {
  cst: string; // CST ou CSOSN
  value: number; // vProd - vDesc + vFrete + vSeg + vOutro
  vProd: number;
  vICMS: number;
  vBC?: number;
  vST: number;
  vIPI: number;
  vPIS: number;
  vCOFINS: number;
  ibsBase?: number;
  pRedBC?: string;
  pDif?: string;
}
export interface GenNote {
  model: MGroup; // conteúdo de infNFe (sem o próprio infNFe)
  chave: string;
  items: ItemInfo[];
  uf: string;
  ibs: boolean;
  ibsFormula: 'item' | 'item-icms';
  crt: '1' | '3';
}

const UFS = [
  { uf: 'RS', c: '43', mun: '4310207', xMun: 'IJUI', cep: '98700000', fuso: '-03:00' },
  { uf: 'SP', c: '35', mun: '3550308', xMun: 'SAO PAULO', cep: '01001000', fuso: '-03:00' },
  { uf: 'PR', c: '41', mun: '4106902', xMun: 'CURITIBA', cep: '80010000', fuso: '-03:00' },
  { uf: 'MT', c: '51', mun: '5103403', xMun: 'CUIABA', cep: '78005000', fuso: '-04:00' },
] as const;
const DEST_UF = [
  { uf: 'SC', mun: '4205407', xMun: 'FLORIANOPOLIS', cep: '88010000' },
  { uf: 'MG', mun: '3106200', xMun: 'BELO HORIZONTE', cep: '30110000' },
] as const;
const PRODUTOS = [
  ['MILHO EM GRAOS', '10059010', 'KG'],
  ['SOJA EM GRAOS', '12019000', 'KG'],
  ['FERTILIZANTE NPK 05-20-20', '31052000', 'SC'],
  ['OLEO LUBRIFICANTE 20W50', '27101932', 'LT'],
  ['PARAFUSO SEXTAVADO 1/2', '73181500', 'UN'],
  ['RACAO BOVINA 40KG', '23099010', 'SC'],
] as const;

function cnpjDV(base12: string): string {
  const calc = (s: string, w: number[]) => {
    const t = [...s].reduce((acc, d, i) => acc + +d * w[i], 0) % 11;
    return t < 2 ? 0 : 11 - t;
  };
  const d1 = calc(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(base12 + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base12 + d1 + d2;
}
function cpfDV(base9: string): string {
  const calc = (s: string) => {
    const t = [...s].reduce((acc, d, i) => acc + +d * (s.length + 1 - i), 0) % 11;
    return t < 2 ? 0 : 11 - t;
  };
  const d1 = calc(base9);
  return base9 + d1 + calc(base9 + d1);
}
const digits = (r: R, n: number) => Array.from({ length: n }, () => r.int(0, 9)).join('');

export interface GenOptions {
  /** força características para cobrir casos específicos */
  crt?: '1' | '3';
  ibs?: boolean;
  items?: number;
  csts?: string[]; // ordem dos CST/CSOSN dos itens
  interestadual?: boolean;
  pf?: boolean;
}

export function genNote(seed: number, opt: GenOptions = {}): GenNote {
  const r = rng(seed);
  const E = r.pick(UFS);
  const crt = opt.crt ?? (r.chance(0.3) ? '1' : '3');
  const inter = opt.interestadual ?? r.chance(0.25);
  const pf = opt.pf ?? (!inter && r.chance(0.3));
  const D = inter ? r.pick(DEST_UF) : { uf: E.uf, mun: E.mun, xMun: E.xMun, cep: E.cep };
  const ibs = opt.ibs ?? r.chance(0.7);
  const ibsFormula: GenNote['ibsFormula'] = r.chance(0.5) ? 'item' : 'item-icms';
  const nItems = opt.items ?? r.int(1, 5);
  const cnpjEmit = cnpjDV(digits(r, 8) + '0001');
  const cNF = String(r.int(10000000, 99999999));
  const nNF = String(r.int(1, 999999));
  const serie = String(r.int(0, 9));
  const day = r.int(20, 27);
  const dh = `2026-10-${String(day).padStart(2, '0')}T${String(r.int(7, 11)).padStart(2, '0')}:${String(r.int(10, 59))}:${String(r.int(10, 59))}${E.fuso}`;
  const tpEmis = '1';
  const c43 = E.c + '2610' + cnpjEmit + '55' + serie.padStart(3, '0') + nNF.padStart(9, '0') + tpEmis + cNF;
  const chave = c43 + dvChave(c43);
  const idDest = inter ? '2' : '1';
  const indFinal = pf ? '1' : r.pick(['0', '1']);

  const ide: MGroup = {
    cUF: E.c, cNF, natOp: 'VENDA DE MERCADORIA', mod: '55', serie, nNF, dhEmi: dh, dhSaiEnt: dh,
    tpNF: '1', idDest, cMunFG: E.mun, tpImp: '1', tpEmis, cDV: chave[43], tpAmb: '2', finNFe: '1',
    indFinal, indPres: '1', indIntermed: '0', procEmi: '0', verProc: 'GERADOR-TESTE 1.0',
  };
  const emit: MGroup = {
    CNPJ: cnpjEmit, xNome: 'EMPRESA TESTE ' + digits(r, 3) + ' LTDA',
    enderEmit: { xLgr: 'RUA DO COMERCIO', nro: String(r.int(1, 9999)), xBairro: 'CENTRO', cMun: E.mun, xMun: E.xMun, UF: E.uf, CEP: E.cep, cPais: '1058', xPais: 'BRASIL', fone: '55' + digits(r, 8) },
    IE: digits(r, 10), CRT: crt,
  };
  const dest: MGroup = pf
    ? { CPF: cpfDV(digits(r, 9)), xNome: 'CONSUMIDOR TESTE', enderDest: { xLgr: 'RUA A', nro: '10', xBairro: 'CENTRO', cMun: D.mun, xMun: D.xMun, UF: D.uf, CEP: D.cep, cPais: '1058', xPais: 'BRASIL' }, indIEDest: '9' }
    : { CNPJ: cnpjDV(digits(r, 8) + '0001'), xNome: 'CLIENTE TESTE ' + digits(r, 3) + ' LTDA', enderDest: { xLgr: 'AV BRASIL', nro: String(r.int(1, 999)), xBairro: 'INDUSTRIAL', cMun: D.mun, xMun: D.xMun, UF: D.uf, CEP: D.cep, cPais: '1058', xPais: 'BRASIL' }, indIEDest: '1', IE: digits(r, 10) };

  const cstPool = crt === '1' ? ['102', '101', '500'] : pf ? ['00', '20', '40', '60'] : ['00', '20', '10', '40', '51', '60'];
  const dets: MGroup[] = [];
  const items: ItemInfo[] = [];
  for (let i = 0; i < nItems; i++) {
    const [xProd, NCM, uCom] = r.pick(PRODUTOS);
    const qCom = r.chance(0.5) ? r.int(1, 500) : r.int(1, 99999) / 1000;
    const vUn = r.chance(0.5) ? r.int(100, 99999) / 100 : r.int(1000, 9999999) / 10000;
    const vProd = r2(qCom * vUn);
    const vFrete = r.chance(0.3) ? r.int(100, 5000) / 100 : 0;
    const vSeg = r.chance(0.15) ? r.int(100, 2000) / 100 : 0;
    const vOutro = r.chance(0.15) ? r.int(100, 2000) / 100 : 0;
    const vDesc = r.chance(0.3) ? Math.min(r2(vProd * 0.1), r.int(1, 3000) / 100) : 0;
    const value = r2(vProd - vDesc + vFrete + vSeg + vOutro);
    const cfop = (inter ? '6' : '5') + (crt === '1' ? '102' : '102');
    const prod: MGroup = {
      cProd: String(1000 + i), cEAN: 'SEM GTIN', xProd, NCM, CFOP: cfop, uCom, qCom: f4(qCom), vUnCom: vUn.toFixed(4), vProd: f2(vProd),
      cEANTrib: 'SEM GTIN', uTrib: uCom, qTrib: f4(qCom), vUnTrib: vUn.toFixed(4),
      vFrete: vFrete ? f2(vFrete) : undefined, vSeg: vSeg ? f2(vSeg) : undefined, vDesc: vDesc ? f2(vDesc) : undefined, vOutro: vOutro ? f2(vOutro) : undefined,
      indTot: '1',
    };
    const cst = opt.csts?.[i] ?? r.pick(cstPool);
    const info: ItemInfo = { cst, value, vProd, vICMS: 0, vST: 0, vIPI: 0, vPIS: 0, vCOFINS: 0 };
    const p = r.pick([7, 12, 17, 18, 19.5]);
    let icms: MGroup;
    switch (cst) {
      case '00': { const vICMS = r2((value * p) / 100); icms = { ICMS00: { orig: '0', CST: '00', modBC: '3', vBC: f2(value), pICMS: p.toFixed(2), vICMS: f2(vICMS) } }; Object.assign(info, { vICMS, vBC: value }); break; }
      case '20': {
        const red = r.pick([33.33, 41.1765, 61.11, 10]);
        const vBC = r2(value * (1 - red / 100)); const vICMS = r2((vBC * p) / 100);
        icms = { ICMS20: { orig: '0', CST: '20', modBC: '3', pRedBC: red.toFixed(4), vBC: f2(vBC), pICMS: p.toFixed(2), vICMS: f2(vICMS) } };
        Object.assign(info, { vICMS, vBC, pRedBC: red.toFixed(4) }); break;
      }
      case '10': {
        const vICMS = r2((value * p) / 100);
        const mva = r.pick([30, 40, 71.78]); const pST = 18;
        const vBCST = r2(value * (1 + mva / 100)); const vST = r2((vBCST * pST) / 100 - vICMS);
        icms = { ICMS10: { orig: '0', CST: '10', modBC: '3', vBC: f2(value), pICMS: p.toFixed(2), vICMS: f2(vICMS), modBCST: '4', pMVAST: mva.toFixed(2), vBCST: f2(vBCST), pICMSST: pST.toFixed(2), vICMSST: f2(vST) } };
        Object.assign(info, { vICMS, vBC: value, vST, vBCST }); break;
      }
      case '51': {
        const red = r.pick([0, 0, 33.33, 41.1765]);
        const vBC = r2(value * (1 - red / 100));
        const pDif = r.pick([100, 33.33, 41.1765, 66.6667]);
        const vOp = r2((vBC * p) / 100); const vDif = r2((vOp * pDif) / 100); const vICMS = r2(vOp - vDif);
        icms = { ICMS51: { orig: '0', CST: '51', modBC: '3', pRedBC: red ? red.toFixed(4) : '0.00', vBC: f2(vBC), pICMS: p.toFixed(2), vICMSOp: f2(vOp), pDif: pDif.toFixed(4), vICMSDif: f2(vDif), vICMS: f2(vICMS) } };
        Object.assign(info, { vICMS, vBC, pRedBC: red ? red.toFixed(4) : '0.00', pDif: pDif.toFixed(4) }); break;
      }
      case '40': icms = { ICMS40: { orig: '0', CST: '40' } }; break;
      case '60': icms = { ICMS60: { orig: '0', CST: '60' } }; break;
      case '101': { const pc = 2.56; icms = { ICMSSN101: { orig: '0', CSOSN: '101', pCredSN: pc.toFixed(2), vCredICMSSN: f2((value * pc) / 100) } }; break; }
      case '102': icms = { ICMSSN102: { orig: '0', CSOSN: '102' } }; break;
      case '500': icms = { ICMSSN500: { orig: '0', CSOSN: '500' } }; break;
      default: throw new Error('CST ' + cst);
    }
    const ipiTrib = crt === '3' && r.chance(0.3);
    let IPI: MGroup;
    if (ipiTrib) {
      const pI = r.pick([5, 10]); const vIPI = r2((value * pI) / 100);
      IPI = { cEnq: '999', IPITrib: { CST: '50', vBC: f2(value), pIPI: pI.toFixed(2), vIPI: f2(vIPI) } };
      info.vIPI = vIPI;
    } else IPI = { cEnq: '999', IPINT: { CST: '53' } };
    let PIS: MGroup, COFINS: MGroup;
    if (crt === '3' && r.chance(0.4)) {
      const vPIS = r2((value * 1.65) / 100), vCOF = r2((value * 7.6) / 100);
      PIS = { PISAliq: { CST: '01', vBC: f2(value), pPIS: '1.65', vPIS: f2(vPIS) } };
      COFINS = { COFINSAliq: { CST: '01', vBC: f2(value), pCOFINS: '7.60', vCOFINS: f2(vCOF) } };
      info.vPIS = vPIS; info.vCOFINS = vCOF;
    } else { PIS = { PISNT: { CST: '07' } }; COFINS = { COFINSNT: { CST: '07' } }; }
    const imposto: MGroup = { ICMS: icms, IPI, PIS, COFINS };
    if (ibs) {
      const base = r2(ibsFormula === 'item' ? value : value - info.vICMS);
      const red = r.chance(0.3);
      const aUF = red ? 0.04 : 0.1, aCBS = red ? 0.36 : 0.9;
      const vUF = r2((base * aUF) / 100), vCBS = r2((base * aCBS) / 100);
      const esf = (pTag: string, aliq: string, vTag: string, v: number) => (red ? { [pTag]: aliq, gRed: { pRedAliq: '60.0000', pAliqEfet: (+aliq * 0.4).toFixed(4) }, [vTag]: f2(v) } : { [pTag]: aliq, [vTag]: f2(v) });
      imposto.IBSCBS = {
        CST: red ? '200' : '000', cClassTrib: red ? '200038' : '000001',
        gIBSCBS: {
          vBC: f2(base),
          gIBSUF: esf('pIBSUF', '0.1000', 'vIBSUF', vUF),
          gIBSMun: esf('pIBSMun', '0.0000', 'vIBSMun', 0),
          vIBS: f2(vUF),
          gCBS: esf('pCBS', '0.9000', 'vCBS', vCBS),
        },
      };
      info.ibsBase = base;
      (info as any).vIBSUF = vUF; (info as any).vCBS = vCBS;
    }
    dets.push({ '@nItem': String(i + 1), prod, imposto });
    items.push(info);
  }

  // totais
  const S = (fn: (i: ItemInfo) => number) => r2(items.reduce((a, i) => a + Math.round(fn(i) * 100), 0) / 100);
  const pv = (k: string) => (d: MGroup) => +(((d.prod as MGroup)[k] as string | undefined) ?? 0);
  const SD = (fn: (d: MGroup) => number) => r2(dets.reduce((a, d) => a + Math.round(fn(d) * 100), 0) / 100);
  const vProd = SD(pv('vProd')), vFrete = SD(pv('vFrete')), vSeg = SD(pv('vSeg')), vDesc = SD(pv('vDesc')), vOutro = SD(pv('vOutro'));
  const vST = S((i) => i.vST), vIPI = S((i) => i.vIPI);
  const vNF = r2(vProd - vDesc + vST + vFrete + vSeg + vOutro + vIPI);
  const ICMSTot: MGroup = {
    vBC: f2(S((i) => i.vBC ?? 0)), vICMS: f2(S((i) => i.vICMS)), vICMSDeson: '0.00', vFCP: '0.00',
    vBCST: f2(S((i) => (i as any).vBCST ?? 0)), vST: f2(vST), vFCPST: '0.00', vFCPSTRet: '0.00',
    vProd: f2(vProd), vFrete: f2(vFrete), vSeg: f2(vSeg), vDesc: f2(vDesc), vII: '0.00', vIPI: f2(vIPI), vIPIDevol: '0.00',
    vPIS: f2(S((i) => i.vPIS)), vCOFINS: f2(S((i) => i.vCOFINS)), vOutro: f2(vOutro), vNF: f2(vNF),
  };
  const total: MGroup = { ICMSTot };
  if (ibs) {
    const vUF = S((i) => (i as any).vIBSUF), vCBS = S((i) => (i as any).vCBS);
    total.IBSCBSTot = {
      vBCIBSCBS: f2(S((i) => i.ibsBase!)),
      gIBS: { gIBSUF: { vDif: '0.00', vDevTrib: '0.00', vIBSUF: f2(vUF) }, gIBSMun: { vDif: '0.00', vDevTrib: '0.00', vIBSMun: '0.00' }, vIBS: f2(vUF), vCredPres: '0.00', vCredPresCondSus: '0.00' },
      gCBS: { vDif: '0.00', vDevTrib: '0.00', vCBS: f2(vCBS), vCredPres: '0.00', vCredPresCondSus: '0.00' },
    };
  }
  // transporte: peso coerente com os itens em KG
  const kg = dets.filter((d) => (d.prod as MGroup).uCom === 'KG').reduce((a, d) => a + +((d.prod as MGroup).qCom as string), 0);
  const transp: MGroup = r.chance(0.5)
    ? { modFrete: '9' }
    : { modFrete: '0', vol: [{ qVol: String(nItems), esp: 'VOLUME', pesoL: (kg || r.int(1, 900)).toFixed(3), pesoB: ((kg || r.int(1, 900)) * 1.02).toFixed(3) }] };
  if (transp.vol) { const v = (transp.vol as MGroup[])[0]; if (+(v.pesoB as string) < +(v.pesoL as string)) v.pesoB = v.pesoL; }
  // cobrança e pagamento
  let cobr: MGroup | undefined;
  let pag: MGroup;
  if (r.chance(0.5)) {
    const n = r.int(1, 3);
    const parc = r2(Math.floor((vNF / n) * 100) / 100);
    const dups: MGroup[] = [];
    for (let k = 0; k < n; k++) {
      const v = k === n - 1 ? r2(vNF - parc * (n - 1)) : parc;
      dups.push({ nDup: String(k + 1).padStart(3, '0'), dVenc: `2026-${String(11 + Math.floor(k / 2)).padStart(2, '0')}-${String(10 + k).padStart(2, '0')}`, vDup: f2(v) });
    }
    cobr = { fat: { nFat: nNF, vOrig: f2(vNF), vDesc: '0.00', vLiq: f2(vNF) }, dup: dups };
    pag = { detPag: [{ indPag: '1', tPag: '15', vPag: f2(vNF) }] };
  } else if (r.chance(0.5)) {
    const a = r2(Math.floor(vNF * 0.4 * 100) / 100);
    pag = { detPag: [{ indPag: '0', tPag: '01', vPag: f2(a) }, { indPag: '0', tPag: '05', vPag: f2(r2(vNF - a)) }] };
  } else {
    const pago = r2(Math.ceil(vNF / 10) * 10 + 10);
    pag = { detPag: [{ indPag: '0', tPag: '01', vPag: f2(pago) }], vTroco: f2(r2(pago - vNF)) };
  }
  const model: MGroup = {
    '@versao': '4.00', '@Id': 'NFe' + chave,
    ide, emit, dest, det: dets, total, transp, cobr, pag,
    infAdic: { infCpl: 'NOTA GERADA PARA TESTE AUTOMATIZADO; SEM VALOR FISCAL.' },
    infRespTec: { CNPJ: '12345678000195', xContato: 'SUPORTE TESTE', email: 'suporte@exemplo.com.br', fone: '5533330000' },
  };
  return { model, chave, items, uf: E.uf, ibs, ibsFormula, crt };
}

/* ------------------------------------------------------------------ */
/* Serialização XML (ordem do XSD)                                     */
/* ------------------------------------------------------------------ */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toXml(g: GenNote, opts: { oneLine?: boolean } = {}): string {
  const out: string[] = [];
  const order = (path: string) => nfeDict.get(path)?.o ?? 1e9;
  const walk = (name: string, node: MNode, path: string, depth: number) => {
    const ind = opts.oneLine ? '' : '  '.repeat(depth);
    if (typeof node === 'string') { out.push(`${ind}<${name}>${esc(node)}</${name}>`); return; }
    const attrs = Object.entries(node).filter(([k, v]) => k.startsWith('@') && v !== undefined).map(([k, v]) => ` ${k.slice(1)}="${esc(v as string)}"`).join('');
    const xmlns = name === 'NFe' ? ' xmlns="http://www.portalfiscal.inf.br/nfe"' : '';
    out.push(`${ind}<${name}${xmlns}${attrs}>`);
    const kids = Object.entries(node).filter(([k, v]) => !k.startsWith('@') && v !== undefined);
    kids.sort(([a], [b]) => order(path + '/' + a) - order(path + '/' + b));
    for (const [k, v] of kids) for (const x of Array.isArray(v) ? v : [v]) walk(k, x as MNode, path + '/' + k, depth + 1);
    out.push(`${ind}</${name}>`);
  };
  walk('NFe', { infNFe: g.model }, 'NFe', 0);
  const body = out.join(opts.oneLine ? '' : '\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + body + '\n';
}

/* ------------------------------------------------------------------ */
/* Serialização TX2                                                     */
/* ------------------------------------------------------------------ */
/** ID do leiaute por "grupo/campo" (dados de teste; mesma numeração do MOC usada nos TX2 reais). */
const IDS: Record<string, string> = {
  'infNFe/@Id': 'A03', 'infNFe/@versao': 'A02',
  'ide/cUF': 'B02', 'ide/cNF': 'B03', 'ide/natOp': 'B04', 'ide/mod': 'B06', 'ide/serie': 'B07', 'ide/nNF': 'B08', 'ide/dhEmi': 'B09', 'ide/dhSaiEnt': 'B10',
  'ide/tpNF': 'B11', 'ide/idDest': 'B11a', 'ide/cMunFG': 'B12', 'ide/tpImp': 'B21', 'ide/tpEmis': 'B22', 'ide/cDV': 'B23', 'ide/tpAmb': 'B24',
  'ide/finNFe': 'B25', 'ide/indFinal': 'B25a', 'ide/indPres': 'B25b', 'ide/indIntermed': 'B25c', 'ide/procEmi': 'B26', 'ide/verProc': 'B27',
  'emit/CNPJ': 'C02', 'emit/xNome': 'C03', 'enderEmit/xLgr': 'C06', 'enderEmit/nro': 'C07', 'enderEmit/xBairro': 'C09', 'enderEmit/cMun': 'C10',
  'enderEmit/xMun': 'C11', 'enderEmit/UF': 'C12', 'enderEmit/CEP': 'C13', 'enderEmit/cPais': 'C14', 'enderEmit/xPais': 'C15', 'enderEmit/fone': 'C16',
  'emit/IE': 'C17', 'emit/CRT': 'C21',
  'dest/CNPJ': 'E02', 'dest/CPF': 'E03', 'dest/xNome': 'E04', 'enderDest/xLgr': 'E06', 'enderDest/nro': 'E07', 'enderDest/xBairro': 'E09',
  'enderDest/cMun': 'E10', 'enderDest/xMun': 'E11', 'enderDest/UF': 'E12', 'enderDest/CEP': 'E13', 'enderDest/cPais': 'E14', 'enderDest/xPais': 'E15',
  'dest/indIEDest': 'E16a', 'dest/IE': 'E17',
  'det/@nItem': 'H02',
  'prod/cProd': 'I02', 'prod/cEAN': 'I03', 'prod/xProd': 'I04', 'prod/NCM': 'I05', 'prod/CFOP': 'I08', 'prod/uCom': 'I09', 'prod/qCom': 'I10',
  'prod/vUnCom': 'I10a', 'prod/vProd': 'I11', 'prod/cEANTrib': 'I12', 'prod/uTrib': 'I13', 'prod/qTrib': 'I14', 'prod/vUnTrib': 'I14a',
  'prod/vFrete': 'I15', 'prod/vSeg': 'I16', 'prod/vDesc': 'I17', 'prod/vOutro': 'I17a', 'prod/indTot': 'I17b',
  'ICMS/orig': 'N11', 'ICMS/CST': 'N12', 'ICMS/CSOSN': 'N12a', 'ICMS/modBC': 'N13', 'ICMS/pRedBC': 'N14', 'ICMS/vBC': 'N15', 'ICMS/pICMS': 'N16',
  'ICMS/vICMSOp': 'N16a', 'ICMS/pDif': 'N16b', 'ICMS/vICMSDif': 'N16c', 'ICMS/vICMS': 'N17', 'ICMS/modBCST': 'N18', 'ICMS/pMVAST': 'N19',
  'ICMS/vBCST': 'N21', 'ICMS/pICMSST': 'N22', 'ICMS/vICMSST': 'N23', 'ICMS/pCredSN': 'N29', 'ICMS/vCredICMSSN': 'N30',
  'IPI/cEnq': 'O06', 'IPI/CST': 'O09', 'IPI/vBC': 'O10', 'IPI/pIPI': 'O13', 'IPI/vIPI': 'O14',
  'PIS/CST': 'Q06', 'PIS/vBC': 'Q07', 'PIS/pPIS': 'Q08', 'PIS/vPIS': 'Q09',
  'COFINS/CST': 'S06', 'COFINS/vBC': 'S07', 'COFINS/pCOFINS': 'S08', 'COFINS/vCOFINS': 'S11',
  'IBSCBS/CST': 'UB13', 'IBSCBS/cClassTrib': 'UB14', 'gIBSCBS/vBC': 'UB16', 'gIBSUF/pIBSUF': 'UB18', 'gIBSUF/pRedAliq': 'UB27', 'gIBSUF/pAliqEfet': 'UB28',
  'gIBSUF/vIBSUF': 'UB35', 'gIBSMun/pIBSMun': 'UB37', 'gIBSMun/pRedAliq': 'UB46', 'gIBSMun/pAliqEfet': 'UB47', 'gIBSMun/vIBSMun': 'UB54',
  'gIBSCBS/vIBS': 'UB54a', 'gCBS/pCBS': 'UB56', 'gCBS/pRedAliq': 'UB65', 'gCBS/pAliqEfet': 'UB66', 'gCBS/vCBS': 'UB67',
  'ICMSTot/vBC': 'W03', 'ICMSTot/vICMS': 'W04', 'ICMSTot/vICMSDeson': 'W04a', 'ICMSTot/vFCP': 'W04h', 'ICMSTot/vBCST': 'W05', 'ICMSTot/vST': 'W06',
  'ICMSTot/vFCPST': 'W06a', 'ICMSTot/vFCPSTRet': 'W06b', 'ICMSTot/vProd': 'W07', 'ICMSTot/vFrete': 'W08', 'ICMSTot/vSeg': 'W09', 'ICMSTot/vDesc': 'W10',
  'ICMSTot/vII': 'W11', 'ICMSTot/vIPI': 'W12', 'ICMSTot/vIPIDevol': 'W12a', 'ICMSTot/vPIS': 'W13', 'ICMSTot/vCOFINS': 'W14', 'ICMSTot/vOutro': 'W15', 'ICMSTot/vNF': 'W16',
  'IBSCBSTot/vBCIBSCBS': 'W35', 'gIBS/gIBSUF/vDif': 'W38', 'gIBS/gIBSUF/vDevTrib': 'W39', 'gIBS/gIBSUF/vIBSUF': 'W41', 'gIBS/gIBSMun/vDif': 'W43', 'gIBS/gIBSMun/vDevTrib': 'W44',
  'gIBS/gIBSMun/vIBSMun': 'W46', 'gIBS/vIBS': 'W47', 'gIBS/vCredPres': 'W48', 'gIBS/vCredPresCondSus': 'W49', 'IBSCBSTot/gCBS/vDif': 'W53', 'IBSCBSTot/gCBS/vDevTrib': 'W54',
  'IBSCBSTot/gCBS/vCBS': 'W56', 'IBSCBSTot/gCBS/vCredPres': 'W56a', 'IBSCBSTot/gCBS/vCredPresCondSus': 'W56b',
  'transp/modFrete': 'X02', 'vol/qVol': 'X27', 'vol/esp': 'X28', 'vol/pesoL': 'X31', 'vol/pesoB': 'X32',
  'fat/nFat': 'Y03', 'fat/vOrig': 'Y04', 'fat/vDesc': 'Y05', 'fat/vLiq': 'Y06', 'dup/nDup': 'Y08', 'dup/dVenc': 'Y09', 'dup/vDup': 'Y10',
  'detPag/indPag': 'YA01b', 'detPag/tPag': 'YA02', 'detPag/vPag': 'YA03', 'pag/vTroco': 'YA09',
  'infAdic/infCpl': 'Z03', 'infRespTec/CNPJ': 'ZD02', 'infRespTec/xContato': 'ZD04', 'infRespTec/email': 'ZD05', 'infRespTec/fone': 'ZD06',
};
function idFor(path: string): string {
  const parts = path.split('/').filter((p) => !/^(ICMS\d+|ICMSSN\d+|IPITrib|IPINT|PISAliq|PISNT|COFINSAliq|COFINSNT|gRed|NFe)$/.test(p));
  for (let n = Math.min(3, parts.length); n >= 2; n--) {
    const k = parts.slice(-n).join('/');
    if (IDS[k]) return IDS[k];
  }
  throw new Error('Sem ID de TX2 para ' + path);
}

export function toTx2(g: GenNote, opts: { prefixPag?: boolean; crlf?: boolean } = {}): string {
  const L: string[] = ['INCLUIR'];
  const order = (path: string) => nfeDict.get(path)?.o ?? 1e9;
  const emit = (node: MNode, path: string, idx?: number) => {
    if (typeof node === 'string') {
      const tag = path.split('/').pop()!;
      const pre = opts.prefixPag && path.includes('/detPag/') ? '4' : '';
      L.push(`${pre}${tag}_${idFor(path.replace(/\/@/, '/@'))}${idx ? '_' + idx : ''}=${node}`);
      return;
    }
    for (const [k, v] of Object.entries(node)) if (k.startsWith('@') && v !== undefined && !path.endsWith('/det')) L.push(`${k.slice(1)}_${idFor(path + '/' + k)}=${v}`);
    const kids = Object.entries(node).filter(([k, v]) => !k.startsWith('@') && v !== undefined);
    kids.sort(([a], [b]) => order(path + '/' + a) - order(path + '/' + b));
    for (const [k, v] of kids) {
      const p = path + '/' + k;
      if (k === 'det') {
        (v as MGroup[]).forEach((d) => {
          L.push('', 'INCLUIRITEM', `nItem_H02=${d['@nItem']}`);
          emit(d, p);
          L.push('SALVARITEM');
        });
        continue;
      }
      if (Array.isArray(v)) {
        v.forEach((x, i) => emit(x as MNode, p, v.length > 1 || k === 'detPag' ? i + 1 : idx));
        continue;
      }
      if (typeof v !== 'string') L.push(`*******BLOCO ${k.toUpperCase()}`);
      emit(v as MNode, p, idx);
    }
  };
  emit(g.model, 'NFe/infNFe');
  L.push('SALVAR', '');
  return L.join(opts.crlf ? '\r\n' : '\n');
}
