import type { Analysis, Finding, XNode } from './types';
import { Dict } from './dict';
import { parseXml, XmlSyntaxError, child, descendants, select } from './xml/parse';
import { formatXml } from './xml/format';
import { translateXsdErrors, sweepTree, type RawXsdError } from './xsd/translate';
import { runNfeRules, summarize } from './rules/nfe';
import { looksLikeTx2, parseTx2, buildFromTx2, makeEmptyLookup, tx2GhostFrom } from './tx2/tx2';

/** Executa o xmllint (wasm) — implementado para navegador e para Node (testes). */
export interface XsdRunner {
  validate(xml: string, entry: string): Promise<RawXsdError[]>;
}

export interface Engine {
  dict: Dict;
  runner: XsdRunner;
  schemas: { entry: Record<string, string> };
  /** relógio usado nas regras de prazo (injetável nos testes) */
  now?: () => Date;
}

const SEV_ORDER = { erro: 0, aviso: 1, info: 2 } as const;
const sortFindings = (f: Finding[]) => f.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || (a.line ?? 1e9) - (b.line ?? 1e9));

export async function analyze(text: string, eng: Engine): Promise<Analysis[]> {
  if (looksLikeTx2(text)) return analyzeTx2(text, eng);
  return analyzeXml(text, eng);
}

export async function analyzeXml(text: string, eng: Engine): Promise<Analysis[]> {
  let root: XNode;
  try {
    root = parseXml(text);
  } catch (e) {
    if (e instanceof XmlSyntaxError) {
      return [{
        kind: 'xml', source: text, schemaOk: false, summary: {},
        findings: [{ sev: 'erro', origin: 'estrutura', title: 'XML malformado', message: e.message, line: e.line, fix: { text: 'Corrija a estrutura do arquivo (tags abertas/fechadas, caracteres especiais como & e < precisam ser escapados).' } }],
        fatal: e.message,
      }];
    }
    throw e;
  }
  const { text: formatted, byLine } = formatXml(root);
  const nfes = root.name === 'NFe' ? [root] : descendants(root, 'NFe');
  const entry = eng.schemas.entry[root.name];
  const common: Finding[] = [];
  let schemaFindings: Finding[] = [];
  if (!entry) {
    common.push({
      sev: 'erro', origin: 'estrutura',
      title: `Tag raiz <${root.name}> não é de NF-e`,
      message: root.name === 'CTe' || root.name === 'cteProc' ? 'Este arquivo é um CT-e. Por enquanto o validador cobre NF-e/NFC-e.' : root.name === 'NFSe' || root.name === 'DPS' ? 'Este arquivo é uma NFS-e. Por enquanto o validador cobre NF-e/NFC-e.' : 'O validador reconhece <NFe>, <nfeProc> e <enviNFe>.',
      line: 1,
    });
    return [{ kind: 'xml', source: formatted, findings: common, summary: {}, schemaOk: false }];
  }
  const ns = root.attrs.find((a) => a.name === 'xmlns' || a.name.startsWith('xmlns:'))?.value ?? nfes[0]?.attrs.find((a) => a.name === 'xmlns')?.value;
  if (ns !== 'http://www.portalfiscal.inf.br/nfe') {
    common.push({ sev: 'erro', origin: 'schema', code: '225', title: 'Namespace da NF-e ausente ou errado', message: `A tag <${root.name}> precisa de xmlns="http://www.portalfiscal.inf.br/nfe"${ns ? ` (está "${ns}")` : ''}. Sem isso nenhuma outra tag é reconhecida.`, line: 2, found: ns ?? '(ausente)', expected: 'http://www.portalfiscal.inf.br/nfe', fix: { text: 'Inclua o atributo na tag raiz.', value: 'xmlns="http://www.portalfiscal.inf.br/nfe"' } });
  } else {
    const raw = await eng.runner.validate(formatted, entry);
    const tctx = { dict: eng.dict, byLine };
    schemaFindings = translateXsdErrors(raw, tctx);
    for (const nfe of nfes) schemaFindings.push(...sweepTree(nfe, tctx, schemaFindings));
  }
  const prot = descendants(root, 'protNFe');
  const autorizada = prot.some((p) => ['100', '150'].includes(select(p, 'infProt/cStat')?.text ?? ''));
  if (!nfes.length) {
    return [{ kind: 'xml', source: formatted, findings: sortFindings(dedupe([...common, ...schemaFindings])), summary: {}, schemaOk: !schemaFindings.some((f) => f.sev === 'erro') && !common.length }];
  }
  // uma análise por nota (lote enviNFe pode ter várias); erros de schema vão para a nota onde estão
  const inNote = (f: Finding, n: XNode) => f.line !== undefined && n.fmtLine !== undefined && f.line >= n.fmtLine && f.line <= (n.fmtEndLine ?? n.fmtLine);
  return nfes.map((nfe, i) => {
    const mine = schemaFindings.filter((f) => inNote(f, nfe) || (i === 0 && !nfes.some((n) => inNote(f, n))));
    const findings: Finding[] = [...common, ...mine];
    findings.push(...runNfeRules(nfe, { lineOf: (n) => n?.fmtLine, fieldOf: () => undefined, now: eng.now?.(), dict: eng.dict, autorizada }));
    if (child(nfe, 'Signature') && !autorizada) {
      findings.push({ sev: 'info', origin: 'estrutura', title: 'XML já assinado', message: 'Qualquer correção feita neste arquivo invalida a assinatura digital. Use o validador para achar o problema, corrija no sistema e gere/assine a nota de novo.', line: child(nfe, 'Signature')!.fmtLine });
    }
    pointToGhost(findings, false);
    return {
      kind: 'xml' as const, source: formatted, findings: sortFindings(dedupe(findings)),
      summary: summarize(nfe, root.name === 'nfeProc' ? root : nfe),
      schemaOk: !findings.some((f) => f.origin === 'schema' && f.sev === 'erro'),
    };
  });
}

export async function analyzeTx2(text: string, eng: Engine): Promise<Analysis[]> {
  const notes = parseTx2(text);
  if (!notes.length) {
    return [{ kind: 'tx2', source: text, findings: [{ sev: 'erro', origin: 'estrutura', title: 'Nenhuma nota encontrada no TX2', message: 'Não encontrei campos no formato nome_ID=valor (ex.: cUF_B02=43).', line: 1 }], summary: {}, schemaOk: false }];
  }
  const out: Analysis[] = [];
  for (const note of notes) {
    // o mesmo formato de TX2 é usado para nota de serviço (modelo 98/00 no sistema): fora do escopo do validador
    const modF = note.fields.find((f) => f.tag === 'mod' && f.letters === 'B');
    if (modF && !['55', '65'].includes(modF.value.trim())) {
      const nat = note.fields.find((f) => f.tag === 'natOp')?.value.trim();
      const msg = `Este TX2 é do modelo ${modF.value.trim()}${nat ? ` (${nat})` : ''}, não de NF-e (55) ou NFC-e (65). Nota de serviço tem leiaute próprio e não é validada aqui.`;
      out.push({ kind: 'tx2', source: text, findings: [{ sev: 'info', origin: 'estrutura', title: 'Documento fora do escopo do validador', message: msg, line: modF.line, tx2Field: modF.field }], summary: { modelo: modF.value.trim(), numero: note.fields.find((f) => f.tag === 'nNF')?.value.trim() }, schemaOk: false, fatal: msg, unsupported: true });
      continue;
    }
    const b = buildFromTx2(note, eng.dict);
    const { text: xml, byLine } = formatXml(b.root, { fromValues: true });
    const raw = await eng.runner.validate(xml, eng.schemas.entry.NFe);
    const tctx = {
      dict: eng.dict, byLine,
      tx2Empty: makeEmptyLookup(b),
      tx2GroupLine: (n: XNode) => n.tx2Line,
    };
    let tr = translateXsdErrors(raw, tctx).filter((f) => !(f.title === 'XML sem assinatura digital'));
    // nota sem itens: um aviso claro no lugar de "falta uma destas tags <retirada>, <entrega>, <autXML>, <det>"
    const semItens = !b.root.children[0]?.children.some((c) => c.name === 'det');
    if (semItens) {
      tr = tr.filter((f) => !(f.origin === 'schema' && /<det>/.test(f.title)));
      if (!note.incomplete) tr.push({ sev: 'erro', origin: 'estrutura', code: '225', title: 'Nota sem itens', message: 'O TX2 não tem nenhum bloco INCLUIRITEM ... SALVARITEM. Toda NF-e precisa de pelo menos um item.', line: note.endLine, fix: { text: 'Confira se a nota tem produtos lançados no sistema e gere o TX2 de novo.' } });
    }
    tr.push(...sweepTree(b.root, tctx, tr));
    const findings: Finding[] = [...b.problems, ...tr];
    findings.push(...runNfeRules(b.root, { lineOf: (n) => n?.tx2Line, fieldOf: (n) => n?.tx2Field, now: eng.now?.(), dict: eng.dict }));
    // campos vazios em grupos que foram gerados: aviso leve (podem virar tag vazia dependendo do componente)
    const schemaOk = !tr.some((f) => f.sev === 'erro');
    if (b.idGenerated) {
      const ch = child(b.root.children[0], 'ide') ? b.root.children[0].attrs.find((a) => a.name === 'Id')?.value : undefined;
      if (ch && !/^NFe0+$/.test(ch)) findings.push({ sev: 'info', origin: 'estrutura', title: 'Chave calculada a partir do TX2', message: `O TX2 não traz Id_A03; para validar, a chave foi montada com os campos da nota: ${ch.slice(3)}.`, line: note.startLine });
    }
    // prévias: no TX2, mostra a linha de TX2 que falta; a de XML fica para a aba do XML montado
    for (const f of findings) {
      if (!f.ghosts?.length) continue;
      f.xmlGhosts = f.ghosts;
      const t = f.ghosts.map((g) => tx2GhostFrom(g, b, eng.dict)).filter((g): g is NonNullable<typeof g> => !!g);
      f.ghosts = t.length ? t : undefined;
    }
    pointToGhost(findings, true);
    out.push({
      kind: 'tx2', source: text, generatedXml: xml,
      findings: sortFindings(dedupe(findings)),
      summary: summarize(b.root, b.root),
      ignoredTx2: b.ignored,
      schemaOk,
    });
  }
  return out;
}

/** Quando há prévia de tag que falta, a linha marcada passa a ser a linha depois da qual ela entra. */
function pointToGhost(fs: Finding[], tx2: boolean) {
  for (const f of fs) {
    const g = f.ghosts?.[0];
    if (!g || g.fill || f.fix?.value) continue;
    f.line = g.afterLine;
    if (tx2) f.tx2Field = g.text.split('=')[0];
  }
}

function dedupe(f: Finding[]): Finding[] {
  const seen = new Set<string>();
  return f.filter((x) => {
    const k = `${x.title}|${x.line}|${x.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
