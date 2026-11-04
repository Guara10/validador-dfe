/**
 * Cenários encontrados na revisão independente antes da produção.
 * Cada teste reproduz uma entrada que dava resultado errado e trava o comportamento correto.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/core/analyze';
import { nfeDict, nfeSchemas } from '../src/core/engine-data';
import { chaveFromIde } from '../src/core/rules/nfe';
import { parseXml, child } from '../src/core/xml/parse';
import { suggestValue } from '../src/core/dict';
import { nodeRunner } from './node-runner';

const eng = { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas, now: () => new Date('2026-10-27T12:00:00-03:00') };
const ex = (f: string) => readFileSync(join(__dirname, '..', 'exemplos', f), 'utf8');
const XML = ex('nfe-valida.xml');
const TX2 = ex('nfe-valida.tx2');
/** troca trechos e recalcula a chave, para o teste não acusar 502 por tabela */
function mk(reps: [string | RegExp, string][], base = XML): string {
  let x = base;
  for (const [a, b] of reps) {
    const y = x.replace(a as any, b);
    if (y === x) throw new Error('troca não aplicada: ' + a);
    x = y;
  }
  const inf = child(parseXml(x), 'infNFe')!;
  const ch = chaveFromIde(inf)!;
  return x.replace(/Id="NFe\d+"/, `Id="NFe${ch}"`).replace(/<cDV>\d<\/cDV>/, `<cDV>${ch[43]}</cDV>`);
}
const run = async (t: string) => (await analyze(t, eng))[0];
const codes = (a: Awaited<ReturnType<typeof run>>) => a.findings.filter((f) => f.sev === 'erro').map((f) => f.code);

describe('total certo com item errado', () => {
  it('a SEFAZ rejeita com 532 mesmo assim: o item vira erro 532 e o total não recebe sugestão', async () => {
    const a = await run(ex('erro-calculos.tx2'));
    const item = a.findings.find((f) => f.title === 'vICMS diferente de vBC × pICMS (item 2)')!;
    expect(item.sev).toBe('erro');
    expect(item.code).toBe('532');
    expect(item.fix?.value).toBe('138.00');
    expect(a.findings.some((f) => /^Total vICMS /.test(f.title))).toBe(false);
  });
  it('item sem o grupo ICMS não faz sugerir um total menor', async () => {
    const x = XML.replace(/<ICMS><ICMS00><orig>0<\/orig><CST>00<\/CST><modBC>3<\/modBC><vBC>1500.00<\/vBC><pICMS>12.00<\/pICMS><vICMS>180.00<\/vICMS><\/ICMS00><\/ICMS>/, '<ICMS></ICMS>');
    expect(x).not.toBe(XML);
    const a = await run(x);
    const t = a.findings.find((f) => /^Total vICMS /.test(f.title));
    expect(t?.fix?.value).toBeUndefined();
  });
});

describe('fuso horário', () => {
  it('-02:00 no RS: sugere o mesmo instante em -03:00 (não 1 hora no futuro)', async () => {
    const a = await run(mk([['<dhEmi>2026-10-27T10:15:00-03:00</dhEmi>', '<dhEmi>2026-10-27T11:15:00-02:00</dhEmi>']]));
    const f = a.findings.find((x) => /^Fuso horário de dhEmi/.test(x.title))!;
    expect(f.fix?.value).toBe('2026-10-27T10:15:00-03:00');
    expect(f.code).toBe('703');
  });
  it('fuso atrasado (-04:00 no RS) não é marcado como 703', async () => {
    const a = await run(mk([['<dhEmi>2026-10-27T10:15:00-03:00</dhEmi>', '<dhEmi>2026-10-27T09:15:00-04:00</dhEmi>']]));
    const f = a.findings.find((x) => /^Fuso horário de dhEmi/.test(x.title))!;
    expect(f.code).toBeUndefined();
    expect(f.fix?.value).toBe('2026-10-27T10:15:00-03:00');
  });
  it('Fernando de Noronha aceita -02:00', async () => {
    const a = await run(mk([['<cMunFG>4310207</cMunFG>', '<cMunFG>2605459</cMunFG>'], ['<dhEmi>2026-10-27T10:15:00-03:00</dhEmi>', '<dhEmi>2026-10-27T11:15:00-02:00</dhEmi>']]));
    expect(a.findings.some((x) => /^Fuso horário de dhEmi/.test(x.title))).toBe(false);
  });
});

describe('falsos positivos em operações comuns', () => {
  it('exportação com não contribuinte e indFinal=0 não dá 696', async () => {
    const a = await run(mk([['<idDest>1</idDest>', '<idDest>3</idDest>'], ['<indIEDest>1</indIEDest><IE>0987654321</IE>', '<indIEDest>9</indIEDest>']]));
    expect(codes(a)).not.toContain('696');
  });
  it('consumidor final de outra UF com idDest=1 não dá 773', async () => {
    const a = await run(mk([['<indFinal>0</indFinal>', '<indFinal>1</indFinal>'], ['<UF>RS</UF><CEP>99010000</CEP>', '<UF>SC</UF><CEP>99010000</CEP>']]));
    expect(a.findings.some((f) => f.title === 'Operação marcada como interna para outra UF')).toBe(false);
  });
  it('interestadual com local de entrega em outra UF não dá 772', async () => {
    const entrega = '<entrega><CNPJ>11222333000181</CNPJ><xLgr>RUA B</xLgr><nro>1</nro><xBairro>CENTRO</xBairro><cMun>4205407</cMun><xMun>FLORIANOPOLIS</xMun><UF>SC</UF></entrega>';
    const a = await run(mk([['<idDest>1</idDest>', '<idDest>2</idDest>'], ['</dest>', '</dest>' + entrega], [/<CFOP>5102<\/CFOP>/g, '<CFOP>6102</CFOP>']]));
    expect(a.findings.some((f) => f.title === 'Operação marcada como interestadual na mesma UF')).toBe(false);
  });
  it('nota complementar com quantidade zero não dá 629 nem sugere zerar vProd', async () => {
    const a = await run(mk([['<finNFe>1</finNFe>', '<finNFe>2</finNFe>'], ['<qCom>1000.0000</qCom><vUnCom>1.500000</vUnCom>', '<qCom>0.0000</qCom><vUnCom>0.000000</vUnCom>']]));
    expect(a.findings.some((f) => f.code === '629')).toBe(false);
  });
  it('vNF com diferença de centavos vira aviso, não 610', async () => {
    const a = await run(mk([['<vNF>2650.00</vNF>', '<vNF>2650.02</vNF>'], [/<vPag>2650.00<\/vPag>/, '<vPag>2650.02</vPag>'], [/<vOrig>2650.00<\/vOrig><vDesc>0.00<\/vDesc><vLiq>2650.00<\/vLiq>/, '<vOrig>2650.02</vOrig><vDesc>0.00</vDesc><vLiq>2650.02</vLiq>'], ['<vDup>2650.00</vDup>', '<vDup>2650.02</vDup>']]));
    expect(codes(a)).not.toContain('610');
    expect(a.findings.find((f) => /centavos/.test(f.title))?.sev).toBe('aviso');
  });
  it('importação (CFOP 3xxx) não confere a fórmula do vNF', async () => {
    const a = await run(mk([['<tpNF>1</tpNF>', '<tpNF>0</tpNF>'], [/<CFOP>5102<\/CFOP>/g, '<CFOP>3102</CFOP>'], ['<idDest>1</idDest>', '<idDest>3</idDest>'], ['<vNF>2650.00</vNF>', '<vNF>2900.00</vNF>']]));
    expect(codes(a)).not.toContain('610');
  });
  it('nota de entrada não dá 506 nem 508', async () => {
    const a = await run(mk([['<tpNF>1</tpNF>', '<tpNF>0</tpNF>'], [/<CFOP>5102<\/CFOP>/g, '<CFOP>1102</CFOP>'], ['<dhSaiEnt>2026-10-27T10:15:00-03:00</dhSaiEnt>', '<dhSaiEnt>2026-10-26T10:15:00-03:00</dhSaiEnt>']]));
    expect(a.findings.some((f) => f.code === '506' || f.code === '508')).toBe(false);
  });
  it('XML assinado sem protocolo e antigo: 228 é aviso (pode ser nota já autorizada)', async () => {
    const sig = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>AAAA</DigestValue></Reference></SignedInfo><SignatureValue>AAAA</SignatureValue><KeyInfo><X509Data><X509Certificate>AAAA</X509Certificate></X509Data></KeyInfo></Signature>';
    const [a] = await analyze(XML.replace('</infNFe></NFe>', '</infNFe>' + sig + '</NFe>'), { ...eng, now: () => new Date('2026-12-20T12:00:00-03:00') });
    const f = a.findings.find((x) => x.code === '228')!;
    expect(f.sev).toBe('aviso');
  });
});

describe('sugestão de valores', () => {
  const f = (p: string) => nfeDict.get(p)!.f;
  it('vírgula de milhar no formato americano', () => {
    expect(suggestValue('1,234.56', f('NFe/infNFe/det/prod/vProd'))?.value).toBe('1234.56');
  });
  it('arredondamento decimal exato (1.005 -> 1.01, 2.675 -> 2.68)', () => {
    expect(suggestValue('1.005', f('NFe/infNFe/det/prod/vProd'))?.value).toBe('1.01');
    expect(suggestValue('2.675', f('NFe/infNFe/det/prod/vProd'))?.value).toBe('2.68');
  });
  it('não corta CNPJ, IE nem chave para caber no tamanho', () => {
    expect(suggestValue('123456789012345', f('NFe/infNFe/emit/CNPJ'))).toBeNull();
    expect(suggestValue('1'.repeat(45), f('NFe/infNFe/ide/NFref/refNFe'))).toBeNull();
  });
  it('valor numérico inválido (1e3) não entra nas somas', async () => {
    const a = await run(XML.replace('<vProd>1500.00</vProd><cEANTrib>', '<vProd>1e3</vProd><cEANTrib>'));
    expect(a.findings.some((x) => /Infinity|NaN|∞/.test(x.message))).toBe(false);
    expect(a.findings.some((x) => x.code === '564')).toBe(false);
  });
});

describe('leitura de TX2', () => {
  it('UF e placa da transportadora, do veículo e do reboque vão para os grupos certos', async () => {
    const t = TX2.replace('modFrete_X02=9', 'modFrete_X02=0\nCNPJ_X04=11222333000181\nxNome_X06=TRANSPORTES TESTE LTDA\nUF_X10=RS\nplaca_X19=ABC1D23\nUF_X20=SC\nplaca_X23=XYZ9A87\nUF_X24=PR');
    const a = await run(t);
    const x = a.generatedXml!.replace(/\s+/g, '');
    expect(x).toContain('<transporta><CNPJ>11222333000181</CNPJ><xNome>TRANSPORTESTESTELTDA</xNome><UF>RS</UF></transporta>'.replace(/\s+/g, ''));
    expect(x).toContain('<veicTransp><placa>ABC1D23</placa><UF>SC</UF></veicTransp>');
    expect(x).toContain('<reboque><placa>XYZ9A87</placa><UF>PR</UF></reboque>');
  });
  it('referência de NF modelo 1 no _1 e de produtor rural no _2', async () => {
    const t = TX2.replace('verProc_B27=4.00', 'verProc_B27=4.00\ncUF_BA04_1=43\nAAMM_BA05_1=2609\nCNPJ_BA06_1=11222333000181\nmod_BA07_1=01\nserie_BA08_1=1\nnNF_BA09_1=123\ncUF_BA11_2=43\nAAMM_BA12_2=2609\nCPF_BA14_2=11144477735\nIE_BA15_2=0011223344\nmod_BA16_2=04\nserie_BA17_2=0\nnNF_BA18_2=45');
    const a = await run(t);
    const x = a.generatedXml!.replace(/\s+/g, '');
    expect(x).toContain('<NFref><refNF><cUF>43</cUF>');
    expect(x).toContain('<NFref><refNFP><cUF>43</cUF>');
  });
  it('campos depois do SALVAR sem INCLUIR viram outra nota, com aviso', async () => {
    const t = TX2 + '\ncUF_B02=43\nnNF_B08=99\n';
    const res = await analyze(t, eng);
    expect(res).toHaveLength(2);
    expect(res[1].findings.some((f) => f.title === 'Campos depois do SALVAR sem INCLUIR')).toBe(true);
  });
});
