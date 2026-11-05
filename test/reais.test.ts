/**
 * Comportamentos aprendidos comparando TX2 reais (homologação e produção) com o XML autorizado da mesma chave.
 * Os dados aqui são fictícios; os arquivos reais ficam fora do repositório.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/core/analyze';
import { nfeDict, nfeSchemas } from '../src/core/engine-data';
import { nodeRunner } from './node-runner';
import { genNote, toXml, toTx2 } from './gen/nota';

const eng = { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas, now: () => new Date('2026-10-28T12:00:00-03:00') };
const TX2 = readFileSync(join(__dirname, '..', 'exemplos', 'nfe-valida.tx2'), 'utf8');
const xmlOf = async (t: string) => (await analyze(t, eng))[0].generatedXml!.replace(/\s+/g, '');
const run = async (t: string) => (await analyze(t, eng))[0];
const errs = (a: Awaited<ReturnType<typeof run>>) => a.findings.filter((f) => f.sev === 'erro').map((f) => `${f.code ?? '-'} ${f.title}`);
const afterIde = (t: string, lines: string) => t.replace('verProc_B27=4.00', 'verProc_B27=4.00\n' + lines);

describe('leitura de TX2 igual ao componente de emissão', () => {
  it('autXML: CNPJ_G51_1 e CPF_G52_1 viram dois autorizados', async () => {
    const x = await xmlOf(TX2.replace('*******TOTAIS', 'CPF_G52_1=22255588846\nCNPJ_G51_1=44668811000130\n*******TOTAIS'));
    expect(x).toContain('<autXML><CNPJ>44668811000130</CNPJ></autXML><autXML><CPF>22255588846</CPF></autXML>');
  });
  it('duplicatas repetidas sem índice viram uma duplicata por bloco', async () => {
    const t = TX2.replace('nDup_Y08=001\ndVenc_Y09=2026-11-27\nvDup_Y10=2650.00', 'nDup_Y08=001\ndVenc_Y09=2026-11-27\nvDup_Y10=1325.00\nnDup_Y08=002\ndVenc_Y09=2026-12-27\nvDup_Y10=1325.00');
    const a = await run(t);
    expect(a.generatedXml!.replace(/\s+/g, '')).toContain('<dup><nDup>001</nDup><dVenc>2026-11-27</dVenc><vDup>1325.00</vDup></dup><dup><nDup>002</nDup>');
    expect(a.findings.some((f) => /Campo repetido/.test(f.title))).toBe(false);
  });
  it('SALVARPARTE=NOME fecha a parte (campos seguintes não ficam presos nela)', async () => {
    const t = afterIde(TX2, 'INCLUIRPARTE=NREF\ncUF_BA11=43\nAAMM_BA12=2609\nCPF_BA14=11144477735\nIE_BA15=0011223344\nmod_BA16=04\nserie_BA17=0\nnNF_BA18=45\nSALVARPARTE=NREF')
      .replace('*******TOTAIS', 'CPF_G52_1=22255588846\nCNPJ_G51_1=44668811000130\n*******TOTAIS');
    const a = await run(t);
    expect(errs(a)).toEqual([]);
    expect(a.generatedXml!.replace(/\s+/g, '')).toContain('<NFref><refNFP><cUF>43</cUF>');
  });
  it('espaço no início/fim é removido (como o componente faz), com uma informação', async () => {
    const a = await run(TX2.replace('infCpl_Z03=Documento de exemplo, sem valor fiscal.', 'infCpl_Z03= Documento de exemplo, sem valor fiscal. '));
    expect(errs(a)).toEqual([]);
    expect(a.generatedXml).toContain('<infCpl>Documento de exemplo, sem valor fiscal.</infCpl>');
    expect(a.findings.find((f) => /^Espaço no início ou no fim/.test(f.title))?.sev).toBe('info');
  });
  it('campo vazio que o leiaute aceita vazio sai como tag vazia (cBenef); os outros são omitidos', async () => {
    const t = TX2.replace('NCM_I05=10059010', 'NCM_I05=10059010\ncBenef_I05f=').replace('CRT_C21=3', 'IEST_C18=\nCRT_C21=3');
    const a = await run(t);
    expect(errs(a)).toEqual([]);
    expect(a.generatedXml).toContain('<cBenef></cBenef>');
    expect(a.generatedXml).not.toContain('<IEST>');
  });
  it('obsCont: xCampo é atributo e xTexto fica no mesmo grupo', async () => {
    const x = await xmlOf(TX2.replace('infCpl_Z03=Documento de exemplo, sem valor fiscal.', 'infCpl_Z03=Documento de exemplo, sem valor fiscal.\nxCampo_Z05_2=Troco\nxTexto_Z06_2=10.00\nxCampo_Z05_3=TotRecebido\nxTexto_Z06_3=20.00'));
    expect(x).toContain('<obsContxCampo="Troco"><xTexto>10.00</xTexto></obsCont><obsContxCampo="TotRecebido"><xTexto>20.00</xTexto></obsCont>');
  });
  it('parâmetros da NFC-e depois do SALVAR (CID_TOKEN, COD_CSC) não viram outra nota', async () => {
    const res = await analyze(TX2 + 'CID_TOKEN=000002\nCOD_CSC=00000000-0000-0000-0000-000000000000\nVERSAO_QRCODE=2\n', eng);
    expect(res).toHaveLength(1);
  });
  it('TX2 cortado (sem SALVAR) é apontado como incompleto', async () => {
    const cut = TX2.slice(0, TX2.indexOf('INCLUIRITEM'));
    const a = await run(cut);
    expect(a.findings[0].title).toBe('TX2 incompleto: o arquivo termina sem SALVAR');
    expect(a.findings.some((f) => /<det>/.test(f.title))).toBe(false);
  });
  it('TX2 de nota de serviço (modelo 98) não é validado como NF-e', async () => {
    const a = await run(TX2.replace('mod_B06=55', 'mod_B06=98').replace('natOp_B04=VENDA DE MERCADORIA', 'natOp_B04=PRESTACAO DE SERVICO TRIBUTADO PELO ISSQN'));
    expect(a.unsupported).toBe(true);
    expect(a.findings.every((f) => f.sev === 'info')).toBe(true);
  });
});

describe('ajustes por evidência das notas autorizadas', () => {
  it('cListServ com o código de tributação nacional (170101) sugere 17.01', async () => {
    const g = genNote(301, { items: 1 });
    const x = toXml(g).replace('<IPI>', '<ISSQN><vBC>10.00</vBC><vAliq>5.00</vAliq><vISSQN>0.50</vISSQN><cMunFG>4310207</cMunFG><cListServ>170101</cListServ><indISS>1</indISS><indIncentivo>2</indIncentivo></ISSQN><IPI>');
    const a = await run(x);
    const f = a.findings.find((y) => /cListServ/.test(y.title))!;
    expect(f.code).toBe('225');
    expect(f.fix?.value).toBe('17.01');
  });
  it('pagamento menor que o total em NF-e é informação (não aviso), e a NFC-e continua avisando', async () => {
    const t = TX2.replace('vPag_YA03_1=2650.00', 'vPag_YA03_1=2610.25');
    const a = await run(t);
    expect(a.findings.find((f) => /^Pagamentos menores/.test(f.title))?.sev).toBe('info');
  });
  it('duplicatas que começam na parcela 002 (entrada à vista): 851 continua erro (MOC Y10-10), com a dica da entrada', async () => {
    const a = await run(TX2.replace('nDup_Y08=001\ndVenc_Y09=2026-11-27\nvDup_Y10=2650.00', 'nDup_Y08=002\ndVenc_Y09=2026-11-27\nvDup_Y10=1325.00'));
    const f = a.findings.find((x) => /duplicatas/.test(x.title))!;
    expect(f.sev).toBe('erro');
    expect(f.code).toBe('851');
    expect(f.message).toMatch(/entrada/);
  });
  it('qrCode da NFC-e versão 3 (padrões alternativos do XSD) não é acusado', async () => {
    const { nfeDict: d } = await import('../src/core/engine-data');
    const { valueOk } = await import('../src/core/dict');
    const f = d.get('NFe/infNFeSupl/qrCode')!.f;
    expect(valueOk('https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=43260666881133000122650200000002631014687425|3|2', f)).toBe(true);
  });
});

describe('devolução e documentos referenciados', () => {
  const dev = genNote(401, { fin: '4', items: 2 });
  it('devolução válida (gerada) não tem erro nem aviso, em XML e TX2', async () => {
    for (const t of [toXml(dev), toTx2(dev)]) {
      const a = await run(t);
      expect(a.findings.filter((f) => f.sev !== 'info').map((f) => f.title)).toEqual([]);
    }
  });
  it('321: devolução sem NFref', async () => {
    const m = structuredClone(dev.model); delete (m.ide as any).NFref;
    const a = await run(toTx2({ ...dev, model: m }));
    expect(errs(a)).toContain('321 Devolução sem documento referenciado');
  });
  it('547: chave referenciada com DV errado aponta a linha do refNFe', async () => {
    const m = structuredClone(dev.model);
    const k = (m.ide as any).NFref[0].refNFe as string;
    (m.ide as any).NFref[0].refNFe = k.slice(0, 43) + String((+k[43] + 1) % 10);
    const a = await run(toTx2({ ...dev, model: m }));
    const f = a.findings.find((x) => x.code === '547')!;
    expect(f.tx2Field).toBe('refNFe_BA02');
  });
  it('327 e 328: CFOP x finalidade', async () => {
    const m = structuredClone(dev.model); (m.det as any)[0].prod.CFOP = (m.det as any)[0].prod.CFOP.replace('202', '102');
    expect((await run(toXml({ ...dev, model: m }))).findings.some((f) => f.code === '327')).toBe(true);
    const n = genNote(402, { fin: '1', ref: 'none', items: 1 });
    const m2 = structuredClone(n.model); (m2.det as any)[0].prod.CFOP = (m2.det as any)[0].prod.CFOP.replace(/\d{3}$/, '202');
    expect((await run(toXml({ ...n, model: m2 }))).findings.some((f) => f.code === '328')).toBe(true);
  });
  it('CFOPs reais de devolução e de retorno não geram 327/328 (1202, 1503, 5918, 6202 em devolução; 5906 e 1949 em nota normal)', async () => {
    for (const [fin, cfop] of [['4', '1202'], ['4', '1503'], ['4', '5918'], ['4', '6202'], ['1', '5906'], ['1', '1949']] as const) {
      const g = genNote(403, { fin, items: 1, interestadual: cfop[0] === '6' || cfop[0] === '2' });
      const m = structuredClone(g.model);
      (m.det as any)[0].prod.CFOP = cfop;
      if ('12'.includes(cfop[0])) (m.ide as any).tpNF = '0';
      const a = await run(toXml({ ...g, model: m }));
      expect(a.findings.filter((f) => f.code === '327' || f.code === '328').map((f) => f.title)).toEqual([]);
    }
  });
  it('várias chaves referenciadas sem índice no TX2 viram vários NFref', async () => {
    const t = afterIde(TX2, 'refNFe_BA02=43260912345678000195550010000009991123456780\nrefNFe_BA02=43260912345678000195550010000009981123456783');
    const x = await xmlOf(t);
    expect(x.match(/<NFref><refNFe>/g)?.length).toBe(2);
  });
});
