import type { Analysis, Finding, XNode } from './types';
import { Dict } from './dict';
import { parseXml, XmlSyntaxError, child, descendants } from './xml/parse';
import { formatXml } from './xml/format';
import { translateXsdErrors, sweepTree, type RawXsdError } from './xsd/translate';
import { runNfeRules, summarize } from './rules/nfe';
import { looksLikeTx2, parseTx2, buildFromTx2, makeEmptyLookup } from './tx2/tx2';

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
  return [await analyzeXml(text, eng)];
}

function findNFe(root: XNode): XNode | undefined {
  if (root.name === 'NFe') return root;
  return descendants(root, 'NFe')[0];
}

export async function analyzeXml(text: string, eng: Engine): Promise<Analysis> {
  let root: XNode;
  try {
    root = parseXml(text);
  } catch (e) {
    if (e instanceof XmlSyntaxError) {
      return {
        kind: 'xml', source: text, schemaOk: false, summary: {},
        findings: [{ sev: 'erro', origin: 'estrutura', title: 'XML malformado', message: e.message, line: e.line, fix: { text: 'Corrija a estrutura do arquivo (tags abertas/fechadas, caracteres especiais como & e < precisam ser escapados).' } }],
        fatal: e.message,
      };
    }
    throw e;
  }
  const { text: formatted, byLine } = formatXml(root);
  const nfe = findNFe(root);
  const entry = eng.schemas.entry[root.name];
  const findings: Finding[] = [];
  let schemaOk = true;
  if (!entry) {
    findings.push({
      sev: 'erro', origin: 'estrutura',
      title: `Tag raiz <${root.name}> não é de NF-e`,
      message: root.name === 'CTe' || root.name === 'cteProc' ? 'Este arquivo é um CT-e. Por enquanto o validador cobre NF-e/NFC-e.' : root.name === 'NFSe' || root.name === 'DPS' ? 'Este arquivo é uma NFS-e. Por enquanto o validador cobre NF-e/NFC-e.' : 'O validador reconhece <NFe>, <nfeProc> e <enviNFe>.',
      line: 1,
    });
    return { kind: 'xml', source: formatted, findings, summary: {}, schemaOk: false };
  }
  const ns = root.attrs.find((a) => a.name === 'xmlns')?.value ?? (nfe ? nfe.attrs.find((a) => a.name === 'xmlns')?.value : undefined);
  if (ns !== 'http://www.portalfiscal.inf.br/nfe') {
    findings.push({ sev: 'erro', origin: 'schema', code: '225', title: 'Namespace da NF-e ausente ou errado', message: `A tag <${root.name}> precisa de xmlns="http://www.portalfiscal.inf.br/nfe"${ns ? ` (está "${ns}")` : ''}. Sem isso nenhuma outra tag é reconhecida.`, line: 2, found: ns ?? '(ausente)', expected: 'http://www.portalfiscal.inf.br/nfe', fix: { text: 'Inclua o atributo na tag raiz.', value: 'xmlns="http://www.portalfiscal.inf.br/nfe"' } });
    schemaOk = false;
  } else {
    const raw = await eng.runner.validate(formatted, entry);
    const tctx = { dict: eng.dict, byLine };
    const tr = translateXsdErrors(raw, tctx);
    if (nfe) tr.push(...sweepTree(nfe, tctx, tr));
    schemaOk = !tr.some((f) => f.sev === 'erro');
    findings.push(...tr);
  }
  if (nfe) {
    findings.push(...runNfeRules(nfe, { lineOf: (n) => n?.fmtLine, fieldOf: () => undefined, now: eng.now?.(), autorizada: root.name === 'nfeProc' && !!descendants(root, 'protNFe').length }));
  }
  return { kind: 'xml', source: formatted, findings: sortFindings(dedupe(findings)), summary: nfe ? summarize(nfe, root) : {}, schemaOk };
}

export async function analyzeTx2(text: string, eng: Engine): Promise<Analysis[]> {
  const notes = parseTx2(text);
  if (!notes.length) {
    return [{ kind: 'tx2', source: text, findings: [{ sev: 'erro', origin: 'estrutura', title: 'Nenhuma nota encontrada no TX2', message: 'Não encontrei campos no formato nome_ID=valor (ex.: cUF_B02=43).', line: 1 }], summary: {}, schemaOk: false }];
  }
  const out: Analysis[] = [];
  for (const note of notes) {
    const b = buildFromTx2(note, eng.dict);
    const { text: xml, byLine } = formatXml(b.root, { fromValues: true });
    const raw = await eng.runner.validate(xml, eng.schemas.entry.NFe);
    const tctx = {
      dict: eng.dict, byLine,
      tx2Empty: makeEmptyLookup(b),
      tx2GroupLine: (n: XNode) => n.tx2Line,
    };
    const tr = translateXsdErrors(raw, tctx).filter((f) => !(f.title === 'XML sem assinatura digital'));
    tr.push(...sweepTree(b.root, tctx, tr));
    const findings: Finding[] = [...b.problems, ...tr];
    findings.push(...runNfeRules(b.root, { lineOf: (n) => n?.tx2Line, fieldOf: (n) => n?.tx2Field, now: eng.now?.() }));
    // campos vazios em grupos que foram gerados: aviso leve (podem virar tag vazia dependendo do componente)
    const schemaOk = !tr.some((f) => f.sev === 'erro');
    if (b.idGenerated) {
      const ch = child(b.root.children[0], 'ide') ? b.root.children[0].attrs.find((a) => a.name === 'Id')?.value : undefined;
      if (ch && !/^NFe0+$/.test(ch)) findings.push({ sev: 'info', origin: 'estrutura', title: 'Chave calculada a partir do TX2', message: `O TX2 não traz Id_A03; para validar, a chave foi montada com os campos da nota: ${ch.slice(3)}.`, line: note.startLine });
    }
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

function dedupe(f: Finding[]): Finding[] {
  const seen = new Set<string>();
  return f.filter((x) => {
    const k = `${x.title}|${x.line}|${x.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
