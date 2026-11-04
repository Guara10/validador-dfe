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
  it('929: CST 51 sem pRedBC aponta a linha do modBC e mostra a linha de TX2 a inserir', async () => {
    const a = await run('erro-929-cst51-sem-predbc.tx2');
    expect(titles(a)).toEqual(['929 CST 51 sem pRedBC (item 1)']);
    const f = a.findings.find((x) => x.code === '929')!;
    // a linha marcada é a do modBC (o campo entra logo depois) e o campo mostrado é o que falta
    expect(f.tx2Field).toBe('pRedBC_N14');
    const g = f.ghosts![0];
    expect(f.line).toBe(g.afterLine);
    expect(g.format).toBe('tx2');
    expect(g.text).toBe('pRedBC_N14=0.00');
    const lines = ex('erro-929-cst51-sem-predbc.tx2').split(/\r?\n/);
    expect(lines[g.afterLine - 1]).toMatch(/^modBC_N13=/);
    // depois de inserir, o aviso some
    lines.splice(g.afterLine, 0, g.text);
    const b = (await analyze(lines.join('\n'), eng))[0];
    expect(b.findings.some((x) => x.code === '929')).toBe(false);
  });
  it('cálculos: total ICMS, vNF e IBS UF', async () => {
    const a = await run('erro-calculos.tx2');
    const t = titles(a);
    // o total vICMS (318,00) está certo: quem está errado é o vICMS do item 2 (183,00 em vez de 138,00)
    expect(t).not.toContain('532 Total vICMS diferente da soma dos itens');
    const item = a.findings.find((f) => f.title === 'vICMS diferente de vBC × pICMS (item 2)')!;
    expect(item.fix?.value).toBe('138.00');
    expect(item.message).toContain('total vICMS');
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

describe('total x item', () => {
  it('total errado de verdade continua sendo apontado no total', async () => {
    const t = ex('nfe-valida.tx2').replace('vICMS_W04=318.00', 'vICMS_W04=320.00');
    const a = (await analyze(t, eng))[0];
    const f = a.findings.find((x) => x.code === '532')!;
    expect(f.fix?.value).toBe('318.00');
  });
});

describe('posição da tag que falta', () => {
  const lineAt = (xml: string, n: number) => xml.split('\n')[n - 1].trim();
  it('929: pRedBC entra logo depois de modBC no XML montado', async () => {
    const a = await run('erro-929-cst51-sem-predbc.tx2');
    const g = a.findings.find((x) => x.code === '929')!.xmlGhosts![0];
    expect(g.text).toBe('<pRedBC>0.00</pRedBC>');
    expect(lineAt(a.generatedXml!, g.afterLine)).toBe('<modBC>3</modBC>');
    expect(lineAt(a.generatedXml!, g.afterLine + 1)).toBe('<vBC>1500.00</vBC>');
  });
  it('225: cEnq entra antes de IPINT no XML montado; no TX2 é a linha vazia a preencher', async () => {
    const a = await run('erro-225-cenq-vazio.tx2');
    const f = a.findings.find((x) => x.code === '225')!;
    const g = f.xmlGhosts![0];
    expect(lineAt(a.generatedXml!, g.afterLine)).toBe('<IPI>');
    expect(lineAt(a.generatedXml!, g.afterLine + 1)).toBe('<IPINT>');
    const t = f.ghosts![0];
    expect(t.fill).toBe(true);
    expect(t.text).toBe('cEnq_O06=…');
    expect(ex('erro-225-cenq-vazio.tx2').split(/\r?\n/)[t.afterLine - 1]).toBe('cEnq_O06=');
  });
  it('1080: grupo IBSCBS entra no fim do imposto (XML) e depois do COFINS do item (TX2)', async () => {
    const a = await run('erro-1080-item-sem-ibscbs.tx2');
    const f = a.findings.find((x) => x.title.includes('sem grupo IBSCBS'))!;
    const g = f.xmlGhosts![0];
    expect(g.group).toBe(true);
    expect(lineAt(a.generatedXml!, g.afterLine + 1)).toBe('</imposto>');
    const t = f.ghosts![0];
    expect(t.text.split('\n')).toEqual(['CST_UB13=…', 'cClassTrib_UB14=…', 'vBC_UB16=1150.00', 'pIBSUF_UB18=…', 'vIBSUF_UB35=…', 'pIBSMun_UB37=…', 'vIBSMun_UB54=…', 'vIBS_UB54a=…', 'pCBS_UB56=…', 'vCBS_UB67=…']);
    const lines = ex('erro-1080-item-sem-ibscbs.tx2').split(/\r?\n/);
    expect(lines[t.afterLine - 1]).toBe('CST_S06=06');
    expect(lines[t.afterLine]).toMatch(/^vItem_VB01=/);
  });
  it('929: pDif e pRedBC calculados com os valores do grupo', async () => {
    const base = ex('nfe-valida.tx2')
      .replace('CST_N12=00', 'CST_N12=51')
      .replace('vICMS_N17=180.00', 'vICMSOp_N16a=180.00\nvICMSDif_N16c=180.00\nvICMS_N17=0.00')
      .replace('vICMS_W04=318.00', 'vICMS_W04=138.00');
    const g1 = (await analyze(base, eng))[0].findings.find((x) => x.code === '929')!.ghosts!;
    expect(g1.map((g) => g.text)).toEqual(['pRedBC_N14=0.00', 'pDif_N16b=100.0000']);
    const reduzida = base.replace('vBC_N15=1500.00', 'vBC_N15=1200.00').replace('vBC_W03=2650.00', 'vBC_W03=2350.00');
    const g2 = (await analyze(reduzida, eng))[0].findings.find((x) => x.code === '929')!.ghosts!;
    expect(g2[0].text).toBe('pRedBC_N14=20.0000');
  });
  it('XML: natOp entra entre cNF e mod', async () => {
    const a = await run('erro-schema-variados.xml');
    const g = a.findings.find((x) => x.title.includes('<natOp>'))!.ghosts![0];
    expect(lineAt(a.source, g.afterLine)).toBe('<cNF>12345678</cNF>');
    expect(lineAt(a.source, g.afterLine + 1)).toBe('<mod>55</mod>');
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
    // o total vProd (2650,00) está certo: o erro é só o vProd do item 2
    expect(t).not.toContain('564 Total vProd diferente da soma dos itens');
    expect(a.findings.find((f) => f.code === '629')!.message).toContain('total vProd');
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
