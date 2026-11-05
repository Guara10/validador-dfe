/**
 * Regras do Anexo I do MOC (Leiaute e Regras de Validação NF-e/NFC-e) com o código de rejeição oficial.
 * Cada caso parte de uma nota gerada válida e planta uma única inconsistência.
 */
import { describe, it, expect } from 'vitest';
import { analyze } from '../src/core/analyze';
import { nfeDict, nfeSchemas } from '../src/core/engine-data';
import { cnpjOk, cpfOk, gtinOk } from '../src/core/rules/moc';
import { nodeRunner } from './node-runner';
import { genNote, toXml, toTx2, HOMOLOG } from './gen/nota';

const eng = { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas, now: () => new Date('2026-10-28T12:00:00-03:00') };
const run = async (t: string) => (await analyze(t, eng))[0];
type M = any;
const base = genNote(501, { items: 2, crt: '3', csts: ['00', '00'], ref: 'none', fin: '1' });
/** aplica a mudança no modelo e devolve os achados de XML e de TX2 */
async function both(change: (m: M) => void, g = base) {
  const m = structuredClone(g.model) as M;
  change(m);
  const n = { ...g, model: m };
  return [await run(toXml(n)), await run(toTx2(n))];
}
const has = (a: Awaited<ReturnType<typeof run>>, code: string) => a.findings.find((f) => f.code === code);

describe('dígitos verificadores', () => {
  it('CNPJ numérico e alfanumérico, CPF e GTIN', () => {
    expect(cnpjOk('11222333000181')).toBe(true);
    expect(cnpjOk('11222333000182')).toBe(false);
    expect(cnpjOk('12ABC34501DE35')).toBe(true); // exemplo da Receita Federal (CNPJ alfanumérico)
    expect(cnpjOk('12ABC34501DE36')).toBe(false);
    expect(cnpjOk('00000000000000')).toBe(false);
    expect(cpfOk('52998224725')).toBe(true);
    expect(cpfOk('52998224726')).toBe(false);
    expect(cpfOk('11111111111')).toBe(false);
    expect(gtinOk('7891000315507')).toBe(true);
    expect(gtinOk('7891000315508')).toBe(false);
    expect(gtinOk('96385074')).toBe(true);
  });
});

describe('regras do MOC', () => {
  it('a nota gerada não dispara nenhuma regra do MOC', async () => {
    for (const a of await both(() => {})) expect(a.findings.filter((f) => f.sev !== 'info').map((f) => `${f.code} ${f.title}`)).toEqual([]);
  });
  it('208: CNPJ do destinatário com DV errado aponta o campo (XML e TX2)', async () => {
    const [x, t] = await both((m) => { m.dest.CNPJ = m.dest.CNPJ.slice(0, 13) + String((+m.dest.CNPJ[13] + 1) % 10); });
    expect(has(x, '208')?.sev).toBe('erro');
    expect(has(t, '208')?.tx2Field).toBe('CNPJ_E02');
  });
  it('598: nome do destinatário em homologação, com o texto exigido como correção', async () => {
    const [x] = await both((m) => { m.dest.xNome = 'CLIENTE DE VERDADE LTDA'; });
    expect(has(x, '598')?.fix?.value).toBe(HOMOLOG);
  });
  it('897: cNF igual ao nNF ou sequência proibida', async () => {
    const [x] = await both((m) => { m.ide.cNF = m.ide.nNF.padStart(8, '0'); });
    expect(has(x, '897')).toBeTruthy();
    const [y] = await both((m) => { m.ide.cNF = '23456789'; });
    expect(has(y, '897')).toBeTruthy();
  });
  it('611 e 885: GTIN com DV errado e cEANTrib SEM GTIN com cEAN preenchido', async () => {
    const [x] = await both((m) => { m.det[0].prod.cEAN = '7891000315508'; m.det[0].prod.cEANTrib = '7891000315508'; });
    expect(has(x, '611')).toBeTruthy();
    expect(has(x, '612')).toBeTruthy();
    const [y] = await both((m) => { m.det[0].prod.cEAN = '7891000315507'; });
    expect(has(y, '885')?.fix?.value).toBe('7891000315507');
  });
  it('806: item com ST sem CEST', async () => {
    const g = genNote(502, { items: 1, crt: '3', csts: ['60'], ref: 'none', fin: '1' });
    const [ok] = await both(() => {}, g);
    expect(has(ok, '806')).toBeFalsy();
    const [x, t] = await both((m) => { delete m.det[0].prod.CEST; }, g);
    expect(has(x, '806')?.sev).toBe('erro');
    expect(has(t, '806')?.tx2Field).toBe('CST_N12');
  });
  it('871: devolução com forma de pagamento diferente de 90', async () => {
    const g = genNote(503, { fin: '4', items: 1 });
    const [x] = await both((m) => { m.pag.detPag[0].tPag = '01'; m.pag.detPag[0].vPag = m.total.ICMSTot.vNF; }, g);
    expect(has(x, '871')?.fix?.value).toBe('90');
  });
  it('904: tPag=90 com valor', async () => {
    const g = genNote(504, { fin: '4', items: 1 });
    const [x] = await both((m) => { m.pag.detPag[0].vPag = '10.00'; }, g);
    expect(has(x, '904')?.fix?.value).toBe('0.00');
  });
  it('869: troco calculado errado mostra o troco certo', async () => {
    const vNF = +(base.model as M).total.ICMSTot.vNF;
    const [x] = await both((m) => { m.cobr = undefined; m.pag = { detPag: [{ indPag: '0', tPag: '01', vPag: (vNF + 50).toFixed(2) }], vTroco: '40.00' }; });
    expect(has(x, '869')?.fix?.value).toBe('50.00');
  });
  it('680: chave referenciada repetida', async () => {
    const g = genNote(505, { fin: '4', items: 1 });
    const [x, t] = await both((m) => { m.ide.NFref = [m.ide.NFref[0], m.ide.NFref[0]]; }, g);
    expect(has(x, '680')).toBeTruthy();
    expect(has(t, '680')).toBeTruthy();
  });
  it('254: complementar sem nota referenciada', async () => {
    const [x] = await both((m) => { m.ide.finNFe = '2'; });
    expect(has(x, '254')?.sev).toBe('erro');
  });
  it('483: desconto maior que o produto e 927: nItem fora de sequência', async () => {
    const [x] = await both((m) => { m.det[0].prod.vDesc = (+m.det[0].prod.vProd + 1).toFixed(2); m.det[1]['@nItem'] = '3'; });
    expect(has(x, '483')).toBeTruthy();
    expect(has(x, '927')?.fix?.value).toBe('2');
  });
  it('273 e 275: município de outra UF', async () => {
    const [x] = await both((m) => { m.emit.enderEmit.cMun = '3550308'; m.dest.enderDest.cMun = '3550308'; });
    if ((base.model as M).emit.enderEmit.UF !== 'SP') expect(has(x, '273')).toBeTruthy();
    if ((base.model as M).dest.enderDest.UF !== 'SP') expect(has(x, '275')).toBeTruthy();
  });
  it('728 e 791: indicador de IE incoerente com a IE informada', async () => {
    const [x] = await both((m) => { delete m.dest.IE; });
    expect(has(x, '728')).toBeTruthy();
    const [y] = await both((m) => { m.dest.indIEDest = '2'; });
    expect(has(y, '791')).toBeTruthy();
  });
  it('880: pFCP zerado', async () => {
    const x = toXml(base).replace(/(<ICMS00>(?:(?!<\/ICMS00>)[\s\S])*<vICMS>[^<]*<\/vICMS>)/, '$1<pFCP>0.00</pFCP><vFCP>0.00</vFCP>');
    expect(has(await run(x), '880')).toBeTruthy();
  });
  it('NFC-e: tpImp, dhSaiEnt, cobrança e duplicata como pagamento', async () => {
    const [x] = await both((m) => { m.ide.mod = '65'; m.ide.tpImp = '1'; m.pag = { detPag: [{ indPag: '0', tPag: '14', vPag: m.total.ICMSTot.vNF }] }; });
    for (const c of ['709', '705', '857']) expect(has(x, c), c).toBeTruthy();
  });
});
