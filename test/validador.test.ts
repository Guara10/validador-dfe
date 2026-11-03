import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/core/analyze';
import { nfeDict, nfeSchemas } from '../src/core/engine-data';
import { nodeRunner } from './node-runner';
import { suggestValue, describeFormat } from '../src/core/dict';

// relógio fixo: os exemplos são de 27/10/2026
const eng = { dict: nfeDict, runner: nodeRunner, schemas: nfeSchemas, now: () => new Date('2026-10-27T12:00:00-03:00') };
const ex = (f: string) => readFileSync(join(__dirname, '..', 'exemplos', f), 'utf8');
const run = async (f: string) => (await analyze(ex(f), eng))[0];
const titles = (a: Awaited<ReturnType<typeof run>>) => a.findings.filter((f) => f.sev !== 'info').map((f) => `${f.code ?? '-'} ${f.title}`);

describe('notas válidas', () => {
  it('TX2 válido não gera erro nem aviso', async () => {
    const a = await run('nfe-valida.tx2');
    expect(a.schemaOk).toBe(true);
    expect(titles(a)).toEqual([]);
  });
  it('XML válido (uma linha só, sem assinatura) não gera erro nem aviso', async () => {
    const a = await run('nfe-valida.xml');
    expect(a.schemaOk).toBe(true);
    expect(titles(a)).toEqual([]);
    expect(a.findings.some((f) => f.title === 'XML sem assinatura digital')).toBe(true);
  });
});

describe('TX2', () => {
  it('225: cEnq vazio aponta a linha do campo vazio', async () => {
    const a = await run('erro-225-cenq-vazio.tx2');
    const f = a.findings.filter((x) => x.code === '225');
    expect(f).toHaveLength(2);
    expect(f[0].tx2Field).toBe('cEnq_O06');
    expect(f[0].message).toContain('está vazio');
  });
  it('1080: item sem grupo IBSCBS', async () => {
    const a = await run('erro-1080-item-sem-ibscbs.tx2');
    expect(titles(a)).toContain('1080 Item 2 sem grupo IBSCBS');
    expect(a.findings.find((f) => f.tx2Field === 'vIBSUF_W41')?.fix?.value).toBe('1.50');
  });
  it('929: CST 51 sem pRedBC', async () => {
    const a = await run('erro-929-cst51-sem-predbc.tx2');
    expect(titles(a)).toEqual(['929 CST 51 sem pRedBC (item 1)']);
  });
  it('cálculos: total ICMS, vNF e IBS UF', async () => {
    const a = await run('erro-calculos.tx2');
    const t = titles(a);
    expect(t).toContain('532 Total vICMS diferente da soma dos itens');
    expect(t).toContain('610 Total da nota (vNF) não fecha com os totais');
    expect(a.findings.find((f) => f.code === '610')?.fix?.value).toBe('2650.00');
  });
  it('formatos: sugere o valor corrigido', async () => {
    const a = await run('erro-formatos.tx2');
    const fix = (field: string) => a.findings.find((f) => f.tx2Field === field)?.fix?.value;
    expect(fix('CEP_E13')).toBe('99010000');
    expect(fix('NCM_I05')).toBe('10059010');
    expect(fix('vProd_I11')).toBe('1500.00');
    expect(fix('xProd_I04')).toBe('MILHO EM GRAOS');
    // valor inválido no item não pode gerar diferença falsa no total
    expect(a.findings.some((f) => f.code === '564')).toBe(false);
  });
});

describe('datas', () => {
  it('228: emissão com mais de 30 dias de atraso', async () => {
    const a = (await analyze(ex('nfe-valida.tx2'), { ...eng, now: () => new Date('2026-12-15T09:00:00-03:00') }))[0];
    const f = a.findings.find((x) => x.code === '228');
    expect(f?.tx2Field).toBe('dhEmi_B09');
  });
  it('506: saída anterior à emissão', async () => {
    const t = ex('nfe-valida.tx2').replace('dhSaiEnt_B10=2026-10-27T10:15:00-03:00', 'dhSaiEnt_B10=2026-10-02T10:15:00-03:00');
    const a = (await analyze(t, eng))[0];
    expect(a.findings.find((x) => x.code === '506')?.fix?.value).toBe('2026-10-27T10:15:00-03:00');
  });
  it('703: emissão no futuro', async () => {
    const a = (await analyze(ex('nfe-valida.tx2'), { ...eng, now: () => new Date('2026-10-26T12:00:00-03:00') }))[0];
    expect(a.findings.some((x) => x.code === '703' && x.title === 'Data de emissão no futuro')).toBe(true);
  });
});

describe('TX2 com numeração antiga', () => {
  it('CNPJ_G51 vai para autXML, não para entrega', async () => {
    const t = ex('nfe-valida.tx2').replace('*******TOTAIS', 'CNPJ_G51_1=33557799000170\n*******TOTAIS');
    const a = (await analyze(t, eng))[0];
    expect(a.schemaOk).toBe(true);
    expect(a.generatedXml).toContain('<autXML>');
    expect(a.generatedXml).not.toContain('<entrega>');
  });
});

describe('caracteres inválidos', () => {
  it('caractere corrompido no nome do emitente', async () => {
    const t = ex('nfe-valida.tx2').replace('xNome_C03=CEREAIS EXEMPLO LTDA', 'xNome_C03=CEREAIS EXEMPLO\uFFFD LTDA');
    const f = (await analyze(t, eng))[0].findings.find((x) => x.tx2Field === 'xNome_C03');
    expect(f?.message).toContain('U+FFFD');
    expect(f?.fix?.value).toBe('CEREAIS EXEMPLO LTDA');
  });
  it('exemplo do menu: caractere inválido no nome do emitente', async () => {
    const a = await run('erro-225-caractere-invalido.tx2');
    const f = a.findings.find((x) => x.tx2Field === 'xNome_C03');
    expect(f?.code).toBe('225');
    expect(f?.fix?.value).toBe('CEREAIS EXEMPLO COMERCIO- E REPRESENTACOES LTDA');
  });
  it('travessão vira hífen', () => {
    expect(suggestValue('ADUBO – FOLIAR', nfeDict.get('NFe/infNFe/det/prod/xProd')!.f)?.value).toBe('ADUBO - FOLIAR');
  });
});

describe('XML', () => {
  it('mostra todos os erros de schema de uma vez', async () => {
    const a = await run('erro-schema-variados.xml');
    const t = titles(a);
    expect(t).toEqual(expect.arrayContaining([
      '225 Falta a tag <natOp> em <ide>',
      '225 Código não aceito em tpNF',
      '225 <CEST> não pertence ao grupo <ide>',
      '225 xNome maior que o permitido',
      '225 <CFOP> fora de ordem em <prod>',
      '225 pICMS fora do formato',
      '225 Campo cEnq vazio',
    ]));
  });
  it('chave e totais', async () => {
    const a = await run('erro-chave-e-totais.xml');
    const t = titles(a);
    expect(t).toContain('502 Chave de acesso não bate com os dados da nota');
    expect(t).toContain('629 vProd diferente de qCom × vUnCom (item 2)');
    expect(t).toContain('564 Total vProd diferente da soma dos itens');
  });
  it('XML malformado', async () => {
    const a = (await analyze('<NFe><infNFe><ide></infNFe></NFe>', eng))[0];
    expect(a.findings[0].title).toBe('XML malformado');
  });
  it('arquivo de outro documento', async () => {
    const a = (await analyze('<cteProc xmlns="http://www.portalfiscal.inf.br/cte"><CTe/></cteProc>', eng))[0];
    expect(a.findings[0].message).toContain('CT-e');
  });
});

describe('correções sugeridas', () => {
  const f = (path: string) => nfeDict.get(path)!.f;
  it('decimais', () => {
    expect(suggestValue('1.234,5', f('NFe/infNFe/det/prod/vProd'))?.value).toBe('1234.50');
    expect(suggestValue('012.00', f('NFe/infNFe/det/prod/vProd'))?.value).toBe('12.00');
    expect(suggestValue('10.123', f('NFe/infNFe/det/prod/vProd'))?.value).toBe('10.12');
  });
  it('descrição do formato', () => {
    expect(describeFormat(f('NFe/infNFe/dest/enderDest/CEP'))).toBe('Somente números, com 8 dígitos');
  });
});
