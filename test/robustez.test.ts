import { describe, it, expect } from 'vitest';
import { analyze } from '../src/core/analyze';
import { nfeDict, nfeSchemas } from '../src/core/engine-data';
import { decodeBytes } from '../src/core/decode';
import { valueFixFor } from '../src/core/fixes';
import { parseXml } from '../src/core/xml/parse';
import { formatXml } from '../src/core/xml/format';
import { nodeRunner } from './node-runner';
import { genNote, toXml, toTx2, rng } from './gen/nota';
import { mutationsFor, runMutation } from './gen/mutations';

const eng = { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas, now: () => new Date('2026-10-28T12:00:00-03:00') };
const problems = (a: { findings: { sev: string; title: string; line?: number }[] }) =>
  a.findings.filter((f) => f.sev !== 'info').map((f) => `${f.sev} L${f.line} ${f.title}`);
const canon = (x: string) => formatXml(parseXml(x), { fromValues: true }).text;

describe('notas geradas: sem falso positivo e TX2 = XML', () => {
  // amostra fixa; a varredura grande fica em `npm run test:stress`
  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
    it(`semente ${seed}`, async () => {
      const g = genNote(seed);
      const xml = toXml(g);
      const [ax] = await analyze(xml, eng);
      expect(problems(ax)).toEqual([]);
      const [a1] = await analyze(toXml(g, { oneLine: true }), eng);
      expect(problems(a1)).toEqual([]);
      const [at] = await analyze(toTx2(g, { prefixPag: seed % 2 === 0, crlf: seed % 3 === 0 }), eng);
      expect(problems(at)).toEqual([]);
      expect(canon(at.generatedXml!)).toBe(canon(xml));
    }, 20000);
  }
});

describe('mutações: acha o erro, sugere o valor original e a nota fica limpa depois de corrigir', () => {
  const g = genNote(2, { crt: '3', ibs: true, items: 3, csts: ['00', '51', '10'], pf: false });
  for (const mu of mutationsFor(g)) {
    for (const kind of ['tx2', 'xml'] as const) {
      it(`${mu.name} [${kind}]`, async () => {
        const r = await runMutation(g, mu, kind, eng);
        expect(r.problems).toEqual([]);
      }, 20000);
    }
  }
});

describe('arquivos com mais de uma nota', () => {
  it('TX2 com duas notas: a correção da segunda nota vai para a linha certa do arquivo', async () => {
    const g1 = genNote(21), g2 = genNote(22);
    const m2 = structuredClone(g2.model);
    const tot = (m2.total as any).ICMSTot;
    const certo = tot.vNF;
    tot.vNF = (+certo + 5).toFixed(2);
    const text = toTx2(g1) + toTx2({ ...g2, model: m2 });
    const res = await analyze(text, eng);
    expect(res).toHaveLength(2);
    expect(problems(res[0])).toEqual([]);
    const f = res[1].findings.find((x) => x.code === '610')!;
    expect(f.fix?.value).toBe(certo);
    const fixed = valueFixFor(f, 'tx2')!(text)!;
    const again = await analyze(fixed, eng);
    expect(again.map(problems)).toEqual([[], []]);
  }, 20000);

  it('lote enviNFe com duas notas: uma análise por nota, cada uma com seus erros', async () => {
    const g1 = genNote(31), g2 = genNote(32);
    const m2 = structuredClone(g2.model);
    (m2.total as any).ICMSTot.vProd = (+(m2.total as any).ICMSTot.vProd + 1).toFixed(2);
    const body = (x: string) => x.replace(/^<\?xml[^>]*>\s*/, '');
    const lote = `<?xml version="1.0" encoding="UTF-8"?>\n<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>1</idLote><indSinc>0</indSinc>${body(toXml(g1))}${body(toXml({ ...g2, model: m2 }))}</enviNFe>`;
    const res = await analyze(lote, eng);
    expect(res).toHaveLength(2);
    expect(problems(res[0])).toEqual([]);
    expect(res[1].findings.some((f) => f.code === '564')).toBe(true);
    expect(res[1].summary.numero).toBe((g2.model.ide as any).nNF);
  }, 20000);
});

describe('nota autorizada (nfeProc)', () => {
  const sig = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI="#NFe{CH}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</DigestValue></Reference></SignedInfo><SignatureValue>QUJD
REVG</SignatureValue><KeyInfo><X509Data><X509Certificate>QUJD
REVG</X509Certificate></X509Data></KeyInfo></Signature>`;
  const proc = (seed: number, cStat = '100') => {
    const g = genNote(seed);
    const nfe = toXml(g).replace(/^<\?xml[^>]*>\s*/, '').replace('</infNFe>\n</NFe>', '</infNFe>\n' + sig.replace('{CH}', g.chave) + '</NFe>');
    return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${nfe}<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS2026</verAplic><chNFe>${g.chave}</chNFe><dhRecbto>2026-10-27T10:00:00-03:00</dhRecbto><nProt>143260000000001</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${cStat}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`;
  };
  it('valida com assinatura e protocolo, e não acusa data atrasada', async () => {
    const [a] = await analyze(proc(41), { ...eng, now: () => new Date('2027-06-01T12:00:00-03:00') });
    expect(a.schemaOk).toBe(true);
    expect(problems(a)).toEqual([]);
    expect(a.summary.autorizada).toBe(true);
  }, 20000);
  it('XML assinado mas ainda não autorizado: avisa que corrigir invalida a assinatura', async () => {
    const g = genNote(42);
    const signed = toXml(g).replace('</infNFe>\n</NFe>', '</infNFe>\n' + sig.replace('{CH}', g.chave) + '</NFe>');
    const [a] = await analyze(signed, eng);
    expect(problems(a)).toEqual([]);
    expect(a.findings.some((f) => f.title === 'XML já assinado')).toBe(true);
  }, 20000);
});

describe('formatos de arquivo', () => {
  it('TX2 em ANSI (Windows-1252) com acento', () => {
    const bytes = new Uint8Array([...'xProd_I04=A'].map((c) => c.charCodeAt(0)).concat([0xc7, 0xc3, 0x4f]));
    expect(decodeBytes(bytes)).toEqual({ text: 'xProd_I04=AÇÃO', latin1: true });
  });
  it('UTF-8 com BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('cUF_B02=43 ç')]);
    expect(decodeBytes(bytes)).toEqual({ text: 'cUF_B02=43 ç', latin1: false });
  });
  it('XML declarado ISO-8859-1', () => {
    const s = '<?xml version="1.0" encoding="ISO-8859-1"?><a>';
    const bytes = new Uint8Array([...s].map((c) => c.charCodeAt(0)).concat([0xe9, ...'</a>'.split('').map((c) => c.charCodeAt(0))]));
    expect(decodeBytes(bytes).text).toBe(s + 'é</a>');
  });
  it('XML com prefixo de namespace, CRLF, comentário, CDATA e entidades', async () => {
    const g = genNote(51);
    let x = toXml(g)
      .replace('<NFe xmlns="http://www.portalfiscal.inf.br/nfe">', '<nfe:NFe xmlns:nfe="http://www.portalfiscal.inf.br/nfe">')
      .replace('</NFe>', '</nfe:NFe>')
      .replace(/<(\/?)(?!nfe:|\?)(\w+)/g, '<$1nfe:$2')
      .replace(/\n/g, '\r\n');
    x = x.replace('<nfe:infCpl>NOTA GERADA PARA TESTE AUTOMATIZADO; SEM VALOR FISCAL.</nfe:infCpl>', '<!-- obs --><nfe:infCpl><![CDATA[NOTA & TESTE <SEM VALOR>]]></nfe:infCpl>');
    const [a] = await analyze(x, eng);
    expect(problems(a)).toEqual([]);
  }, 20000);
});

describe('entradas ruins não derrubam a análise', () => {
  const inputs = ['', '   ', 'abc', '<', '<?xml version="1.0"?>', 'INCLUIR\nSALVAR', 'cUF_B02=43', '\u0000\u0001\u0002binário', '<NFe><infNFe>'.repeat(50), 'x'.repeat(200000)];
  for (const [i, t] of inputs.entries()) {
    it(`entrada ${i}`, async () => {
      const res = await analyze(t, eng);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].findings.length).toBeGreaterThan(0);
    }, 20000);
  }
  it('XML e TX2 cortados em pontos aleatórios', async () => {
    const r = rng(99);
    const g = genNote(61);
    const xml = toXml(g), tx2 = toTx2(g);
    for (let i = 0; i < 25; i++) {
      const src = i % 2 ? xml : tx2;
      const cut = src.slice(0, r.int(1, src.length - 1));
      const res = await analyze(cut, eng);
      expect(res.length).toBeGreaterThan(0);
    }
  }, 60000);
});

describe('desempenho', () => {
  it('nota com 300 itens em menos de 5 segundos (XML e TX2)', async () => {
    const g = genNote(71, { items: 300, ibs: true });
    for (const t of [toXml(g), toTx2(g)]) {
      const t0 = Date.now();
      const [a] = await analyze(t, eng);
      expect(problems(a)).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(5000);
    }
  }, 30000);
});
