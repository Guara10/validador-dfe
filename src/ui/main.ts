import './style.css';
import type { Analysis, Finding } from '../core/types';
import { analyze, type Engine } from '../core/analyze';
import { nfeDict, nfeSchemas } from '../core/engine-data';
import { createBrowserRunner } from '../browser/xsd-runner';

/* ------------------------------------------------------------------ */
/* Exemplos (dados fictícios, da pasta /exemplos)                       */
/* ------------------------------------------------------------------ */
const rawExamples = import.meta.glob('../../exemplos/*.{xml,tx2}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const EXAMPLE_LABELS: [string, string][] = [
  ['erro-225-cenq-vazio.tx2', 'TX2 · 225 com cEnq vazio'],
  ['erro-225-caractere-invalido.tx2', 'TX2 · 225 caractere inválido no nome'],
  ['erro-1080-item-sem-ibscbs.tx2', 'TX2 · 1080 item sem IBS/CBS'],
  ['erro-929-cst51-sem-predbc.tx2', 'TX2 · 929 CST 51 sem pRedBC'],
  ['erro-calculos.tx2', 'TX2 · totais e cálculos'],
  ['erro-formatos.tx2', 'TX2 · formatos (vírgula, CEP, NCM)'],
  ['erro-schema-variados.xml', 'XML · vários erros de schema'],
  ['erro-chave-e-totais.xml', 'XML · chave e totais'],
  ['nfe-valida.tx2', 'TX2 · nota sem erros'],
  ['nfe-valida.xml', 'XML · nota sem erros'],
];
const examples = new Map<string, string>();
for (const [path, txt] of Object.entries(rawExamples)) examples.set(path.split('/').pop()!, txt);

const REJ: Record<string, string> = {
  '225': 'Falha no schema XML',
  '502': 'Chave de acesso não corresponde aos campos',
  '508': 'CST incompatível com não contribuinte',
  '518': 'CFOP de entrada em NF-e de saída',
  '519': 'CFOP de saída em NF-e de entrada',
  '531': 'Total da BC do ICMS difere da soma dos itens',
  '532': 'Total do ICMS difere da soma dos itens',
  '533': 'Total da BC do ICMS ST difere da soma dos itens',
  '534': 'Total do ICMS ST difere da soma dos itens',
  '564': 'Total dos produtos difere da soma dos itens',
  '610': 'Total da NF difere da soma dos valores',
  '629': 'Valor do produto difere de quantidade × valor unitário',
  '696': 'Não contribuinte sem indicação de consumidor final',
  '703': 'Data de emissão posterior ao recebimento',
  '929': 'CST de diferimento sem informações de diferimento',
  '1080': 'Total do IBS da UF difere da soma dos itens',
};

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */
interface State {
  fileName?: string;
  original?: string; // texto como foi carregado
  text?: string; // texto atual (com correções aplicadas)
  results?: Analysis[];
  note: number;
  tab: 'source' | 'xml';
  show: Record<'erro' | 'aviso' | 'info', boolean>;
  applied: number;
  example?: string;
  busy?: boolean;
  error?: string;
}
const S: State = { note: 0, tab: 'source', show: { erro: true, aviso: true, info: true }, applied: 0 };

let engine: Engine | undefined;
function getEngine(): Engine {
  if (!engine) engine = { dict: nfeDict, schemas: nfeSchemas, runner: createBrowserRunner(nfeSchemas.files) };
  return engine;
}

/* ------------------------------------------------------------------ */
/* Helpers de DOM                                                      */
/* ------------------------------------------------------------------ */
type Child = Node | string | null | undefined | false | Child[];
function h(tag: string, attrs: Record<string, any> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c: Child) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  };
  kids.forEach(add);
  return el;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const brl = (v?: string) => (v && !isNaN(+v) ? (+v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : v ?? '');

function toast(msg: string) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
async function copy(text: string, what = 'Copiado') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    const ta = h('textarea', {}, text) as HTMLTextAreaElement;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* sem suporte */ }
    ta.remove();
    toast(ok ? what : 'Não foi possível copiar: selecione o texto e use Ctrl+C');
  }
}
/** downloads são bloqueados dentro do visualizador de artefatos; no arquivo local e no GitHub Pages funcionam */
const canDownload = !/claude|anthropic/.test(location.hostname);
function download(name: string, text: string, latin1: boolean) {
  let blob: Blob;
  if (latin1) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes[i] = c < 256 ? c : 63; }
    blob = new Blob([bytes], { type: 'text/plain' });
  } else blob = new Blob([text], { type: 'text/xml' });
  const a = h('a', { href: URL.createObjectURL(blob), download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
}

/* ------------------------------------------------------------------ */
/* Leitura de arquivos                                                 */
/* ------------------------------------------------------------------ */
let sourceIsLatin1 = false;
async function readFile(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  const head = new TextDecoder('ascii').decode(buf.slice(0, 200));
  const declared = /encoding=["']([^"']+)/i.exec(head)?.[1]?.toLowerCase();
  try {
    sourceIsLatin1 = false;
    if (declared && !/utf-?8/.test(declared)) { sourceIsLatin1 = true; return new TextDecoder(declared).decode(buf); }
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // TX2 gerado por sistemas Windows costuma vir em ANSI (Windows-1252)
    sourceIsLatin1 = true;
    return new TextDecoder('windows-1252').decode(buf);
  }
}

async function load(text: string, fileName: string, example?: string) {
  S.fileName = fileName;
  S.original = text;
  S.text = text;
  S.applied = 0;
  S.note = 0;
  S.tab = 'source';
  S.example = example;
  await run();
}

async function run() {
  if (!S.text) return;
  S.busy = true;
  S.error = undefined;
  render();
  try {
    S.results = await analyze(S.text, getEngine());
    if (S.note >= S.results.length) S.note = 0;
    // análise de XML devolve o texto formatado: passa a ser a base das correções
    const a = S.results[0];
    if (a.kind === 'xml' && !a.fatal) S.text = a.source;
  } catch (e) {
    S.error = (e as Error).message || String(e);
    S.results = undefined;
  }
  S.busy = false;
  render();
}

/* ------------------------------------------------------------------ */
/* Aplicar correção                                                    */
/* ------------------------------------------------------------------ */
function applyTarget(f: Finding, a: Analysis): ((text: string) => string | null) | null {
  if (!f.fix?.value || !f.line) return null;
  const value = f.fix.value;
  if (a.kind === 'tx2') {
    if (!f.tx2Field) return null;
    return (text) => {
      const lines = text.split(/\r?\n/);
      const i = f.line! - 1;
      if (!lines[i] || !lines[i].startsWith(f.tx2Field! + '=')) return null;
      lines[i] = `${f.tx2Field}=${value}`;
      return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
    };
  }
  return (text) => {
    const lines = text.split('\n');
    const i = f.line! - 1;
    const l = lines[i];
    if (l === undefined) return null;
    const leaf = /^(\s*<([\w:]+)(?:\s[^>]*)?>)([^<]*)(<\/\2>\s*)$/.exec(l);
    const xv = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (leaf) { lines[i] = leaf[1] + xv + leaf[4]; return lines.join('\n'); }
    if (/^NFe[0-9A-Z]{44}$/.test(value) && /\sId="[^"]*"/.test(l)) { lines[i] = l.replace(/\sId="[^"]*"/, ` Id="${value}"`); return lines.join('\n'); }
    return null;
  };
}

async function apply(f: Finding) {
  const a = S.results?.[S.note];
  if (!a || !S.text) return;
  const fn = applyTarget(f, a);
  const next = fn?.(S.text);
  if (!next) { toast('Não deu para aplicar automaticamente: edite o arquivo e valide de novo.'); return; }
  S.text = next;
  S.applied++;
  await run();
  toast('Correção aplicada e nota validada de novo');
}

/* ------------------------------------------------------------------ */
/* Relatório em texto (para colar no chamado)                           */
/* ------------------------------------------------------------------ */
function report(a: Analysis): string {
  const s = a.summary;
  const L: string[] = [];
  L.push(`Validação NF-e${s.numero ? ` ${s.numero}` : ''}${s.serie ? ` série ${s.serie}` : ''}${s.emitente ? ` · ${s.emitente}` : ''}`);
  if (s.chave) L.push(`Chave: ${s.chave}`);
  if (S.fileName) L.push(`Arquivo: ${S.fileName} (${a.kind.toUpperCase()})`);
  const n = (sev: string) => a.findings.filter((f) => f.sev === sev).length;
  L.push(`Resultado: ${n('erro')} erro(s), ${n('aviso')} aviso(s)`);
  L.push('');
  for (const f of a.findings.filter((x) => x.sev !== 'info')) {
    L.push(`[${f.sev.toUpperCase()}${f.code ? ' ' + f.code : ''}] ${f.title}`);
    const where = [f.line ? `linha ${f.line}` : '', f.tx2Field ?? '', f.path ?? ''].filter(Boolean).join(' · ');
    if (where) L.push(`  ${where}`);
    L.push(`  ${f.message}`);
    if (f.found) L.push(`  Encontrado: ${f.found}`);
    if (f.expected) L.push(`  Esperado: ${f.expected}`);
    if (f.fix) L.push(`  Correção: ${f.fix.text}${f.fix.value ? ` → ${f.fix.value}` : ''}`);
    L.push('');
  }
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Renderização                                                        */
/* ------------------------------------------------------------------ */
const app = document.getElementById('app')!;
let fileInput: HTMLInputElement;

function topBar() {
  fileInput = h('input', { type: 'file', id: 'arquivo', accept: '.xml,.tx2,.txt', hidden: true, onchange: async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) await load(await readFile(f), f.name);
    (e.target as HTMLInputElement).value = '';
  } }) as HTMLInputElement;
  const sel = h('select', { class: 'btn', id: 'exemplos', 'aria-label': 'Abrir um exemplo', onchange: async (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v && examples.has(v)) { sourceIsLatin1 = false; await load(examples.get(v)!, v, v); }
    (e.target as HTMLSelectElement).value = '';
  } }, h('option', { value: '' }, 'Exemplos'), EXAMPLE_LABELS.filter(([f]) => examples.has(f)).map(([f, l]) => h('option', { value: f }, l)));
  return h('header', { class: 'bar' }, h('div', { class: 'wrap' },
    h('div', { class: 'brand' }, h('h1', {}, 'Validador DF-e'), h('span', {}, 'NF-e e NFC-e · XML e TX2')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, 'Abrir arquivo'),
      S.results ? h('button', { class: 'btn', type: 'button', onclick: () => { S.results = undefined; S.text = undefined; S.example = undefined; render(); } }, 'Colar outro') : null,
      sel, fileInput,
    ),
  ));
}

function inputArea() {
  const ta = h('textarea', { id: 'colar', placeholder: '<?xml version="1.0"...  ou  INCLUIR\ncUF_B02=43\n...', 'aria-label': 'Conteúdo do XML ou TX2', spellcheck: 'false' }) as HTMLTextAreaElement;
  const drop = h('section', { class: 'drop' },
    h('h2', {}, 'Arraste o XML ou o TX2 da nota para cá'),
    h('p', {}, 'Ou cole o conteúdo abaixo. O arquivo é lido só neste navegador; nada é enviado para servidor.'),
    ta,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => ta.value.trim() && load(ta.value, 'conteúdo colado') }, 'Validar'),
      h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Escolher arquivo'),
    ),
  );
  return drop;
}

function summaryBlock(a: Analysis) {
  const s = a.summary;
  const errs = a.findings.filter((f) => f.sev === 'erro');
  const warns = a.findings.filter((f) => f.sev === 'aviso');
  const codes = [...new Set(errs.map((f) => f.code).filter(Boolean))] as string[];
  const warnCodes = [...new Set(warns.map((f) => f.code).filter(Boolean))] as string[];
  const modelo = s.modelo === '65' ? 'NFC-e' : 'NF-e';
  let verdict: HTMLElement;
  if (a.fatal) verdict = h('div', { class: 'v bad' }, 'Arquivo ilegível');
  else if (errs.length) verdict = h('div', { class: 'v bad' }, codes.length ? 'Provável rejeição' : `${errs.length} erro${errs.length > 1 ? 's' : ''} encontrado${errs.length > 1 ? 's' : ''}`);
  else if (warns.length) verdict = h('div', { class: 'v warn' }, 'Sem erros de schema ou de conta; confira os avisos');
  else verdict = h('div', { class: 'v good' }, 'Nenhum problema encontrado');
  return h('section', { class: 'summary', 'aria-label': 'Resumo da nota' },
    h('div', { class: 'doc-id' },
      h('div', { class: 't' }, s.numero ? `${modelo} ${s.numero} · série ${s.serie ?? '?'}` : S.fileName ?? 'Documento',
        s.tpAmb === '2' ? h('span', { class: 'amb' }, 'Homologação') : null,
        s.autorizada ? h('span', { class: 'amb', style: 'background:var(--ok-bg);color:var(--ok)' }, 'Autorizada') : null),
      s.emitente || s.destinatario ? h('div', { class: 'p' }, [s.emitente, s.destinatario].filter(Boolean).join('  →  ')) : null,
      h('div', { class: 'p' }, [s.vNF ? `Total ${brl(s.vNF)}` : '', s.itens ? `${s.itens} ${s.itens > 1 ? 'itens' : 'item'}` : '', s.dhEmi ? `emitida ${s.dhEmi.replace('T', ' ')}` : '', `${a.kind === 'tx2' ? 'TX2' : 'XML'}${S.fileName ? ' · ' + S.fileName : ''}`].filter(Boolean).join(' · ')),
      s.chave ? h('div', { class: 'chave' }, s.chave.replace(/(.{4})/g, '$1 ').trim()) : null,
    ),
    h('div', { class: 'verdict' },
      verdict,
      codes.length ? h('div', { class: 'stamps' }, codes.map((c) => stamp(c, 'erro', REJ[c]))) : null,
      !errs.length && warnCodes.length ? h('div', { class: 'stamps' }, warnCodes.map((c) => stamp(c, 'aviso', REJ[c]))) : null,
      h('div', { class: 'sub' }, errs.length
        ? `${errs.length} erro${errs.length > 1 ? 's' : ''}, ${warns.length} aviso${warns.length === 1 ? '' : 's'}.`
        : 'A SEFAZ ainda confere cadastro, situação do emitente e regras que dependem de consulta, que não dá para validar aqui.'),
    ),
  );
}

function stamp(code: string | undefined, sev: Finding['sev'], title?: string) {
  const label = sev === 'erro' ? 'erro' : sev === 'aviso' ? 'aviso' : 'info';
  return h('span', { class: `stamp ${sev}`, title: title ?? '' }, h('b', {}, code ?? (sev === 'erro' ? '!' : sev === 'aviso' ? '?' : 'i')), h('small', {}, code ? 'rejeição' : label));
}

function card(f: Finding, i: number, a: Analysis) {
  const canApply = !!applyTarget(f, a);
  const meta = h('div', { class: 'meta' },
    f.line ? h('button', { class: 'line-btn', type: 'button', title: 'Mostrar no arquivo', onclick: () => focusLine(f.line!) }, `linha ${f.line}`) : null,
    f.tx2Field ? h('code', {}, f.tx2Field) : null,
    f.path ? h('span', { class: 'path' }, f.path) : null,
    f.code && REJ[f.code] ? h('span', {}, REJ[f.code]) : null,
  );
  return h('article', { class: 'card', id: `achado-${i}`, 'data-line': f.line ?? '' },
    stamp(f.code, f.sev),
    h('h3', {}, f.title),
    meta,
    h('div', { class: 'body' },
      h('p', {}, f.message),
      f.found || f.expected ? h('dl', { class: 'fe' },
        f.found ? [h('dt', {}, 'Encontrado'), h('dd', {}, h('code', {}, f.found))] : null,
        f.expected ? [h('dt', {}, 'Esperado'), h('dd', {}, f.expected)] : null,
      ) : null,
      f.fix ? h('div', { class: 'fix' },
        h('div', { class: 'label' }, 'Como corrigir'),
        h('div', {}, f.fix.text),
        f.fix.value ? h('div', { class: 'val' },
          h('code', {}, f.fix.value),
          h('button', { class: 'btn small', type: 'button', onclick: () => copy(f.fix!.value!, 'Valor copiado') }, 'Copiar'),
          canApply ? h('button', { class: 'btn small', type: 'button', onclick: () => apply(f) }, 'Aplicar no arquivo') : null,
        ) : null,
      ) : null,
      f.doc && !(f.fix?.text ?? '').includes(f.doc) ? h('div', { class: 'doc' }, 'Leiaute: ', f.doc) : null,
    ),
  );
}

function findingsBlock(a: Analysis) {
  const count = (s: Finding['sev']) => a.findings.filter((f) => f.sev === s).length;
  const chip = (sev: 'erro' | 'aviso' | 'info', label: string) =>
    h('button', { class: `chip ${sev}`, type: 'button', 'aria-pressed': String(S.show[sev]), onclick: () => { S.show[sev] = !S.show[sev]; render(); } }, `${label} ${count(sev)}`);
  const list = a.findings.map((f, i) => [f, i] as const).filter(([f]) => S.show[f.sev]);
  return h('section', { class: 'findings', 'aria-label': 'Problemas encontrados' },
    h('div', { class: 'filters' },
      chip('erro', 'Erros'), chip('aviso', 'Avisos'), chip('info', 'Informações'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', type: 'button', onclick: () => copy(report(a), 'Relatório copiado') }, 'Copiar relatório'),
    ),
    list.length ? list.map(([f, i]) => card(f, i, a))
      : h('div', { class: 'empty-ok' }, a.findings.length ? 'Nenhum item com os filtros marcados.' : 'Nenhum problema encontrado no schema, nas contas e nas regras conferidas.'),
  );
}

/* ---------- painel do arquivo ---------- */
function tokenize(line: string, kind: 'xml' | 'tx2'): string {
  if (kind === 'tx2') {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//')) return `<span class="tk-cmt">${esc(line)}</span>`;
    if (/^(INCLUIR|SALVAR|INCLUIRITEM|SALVARITEM|SALVARPARTE|INCLUIRPARTE.*)$/i.test(t)) return `<span class="tk-cmd">${esc(line)}</span>`;
    const i = line.indexOf('=');
    if (i > 0) return `<span class="tk-key">${esc(line.slice(0, i + 1))}</span>${esc(line.slice(i + 1))}`;
    return esc(line);
  }
  return esc(line).replace(/(&lt;\/?)([\w:]+)([^&]*?)(\/?&gt;)/g, '<span class="tk-tag">$1$2</span>$3<span class="tk-tag">$4</span>');
}

function sourceBlock(a: Analysis) {
  const showXml = S.tab === 'xml' && a.generatedXml;
  const text = showXml ? a.generatedXml! : S.text ?? a.source;
  const kind: 'xml' | 'tx2' = showXml || a.kind === 'xml' ? 'xml' : 'tx2';
  const marks = new Map<number, Finding['sev']>();
  if (!showXml) {
    const rank = { erro: 0, aviso: 1, info: 2 };
    for (const f of a.findings) if (f.line && (!marks.has(f.line) || rank[f.sev] < rank[marks.get(f.line)!])) marks.set(f.line, f.sev);
  }
  const lines = text.replace(/\n$/, '').split(/\r?\n/);
  const code = h('div', { class: 'code', id: 'codigo', tabindex: '0', 'aria-label': 'Conteúdo do arquivo' });
  const frag = document.createDocumentFragment();
  lines.forEach((l, i) => {
    const n = i + 1;
    const sev = marks.get(n);
    const row = document.createElement('div');
    row.className = 'ln' + (sev ? ' ' + sev : '');
    row.id = 'l' + n;
    row.innerHTML = `<span class="n">${n}</span><span class="m"${sev ? ' title="Ver o problema desta linha"' : ''}></span><span class="t">${tokenize(l, kind) || ' '}</span>`;
    if (sev) row.querySelector('.m')!.addEventListener('click', () => focusCard(n));
    frag.append(row);
  });
  code.append(frag);

  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(!showXml), onclick: () => { S.tab = 'source'; render(); } }, a.kind === 'tx2' ? 'TX2' : 'XML formatado'),
    a.generatedXml ? h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(!!showXml), onclick: () => { S.tab = 'xml'; render(); } }, 'XML montado do TX2') : null,
  );
  const notes = S.results && S.results.length > 1
    ? h('select', { class: 'btn', id: 'nota', 'aria-label': 'Nota do lote', onchange: (e: Event) => { S.note = +(e.target as HTMLSelectElement).value; render(); } },
      S.results.map((r, i) => h('option', { value: String(i), selected: i === S.note }, `Nota ${i + 1}${r.summary.numero ? ' · nº ' + r.summary.numero : ''}`)))
    : null;
  const head = h('div', { class: 'src-head' }, tabs, h('div', { class: 'actions' }, notes,
    h('button', { class: 'btn small', type: 'button', onclick: () => copy(text, 'Conteúdo copiado') }, 'Copiar')));
  const edits = S.applied ? h('div', { class: 'edits' },
    h('span', {}, `${S.applied} correç${S.applied > 1 ? 'ões aplicadas' : 'ão aplicada'} neste arquivo.`),
    h('button', { class: 'btn small', type: 'button', onclick: () => copy(S.text!, 'Arquivo corrigido copiado') }, 'Copiar arquivo corrigido'),
    canDownload ? h('button', { class: 'btn small', type: 'button', onclick: () => download(correctedName(), S.text!, a.kind === 'tx2' && sourceIsLatin1) }, 'Baixar') : null,
    h('button', { class: 'btn small', type: 'button', onclick: async () => { S.text = S.original; S.applied = 0; await run(); } }, 'Desfazer tudo'),
  ) : h('div', { hidden: true });
  const ign = a.ignoredTx2?.length && !showXml ? h('div', { class: 'src-foot' }, h('details', {},
    h('summary', {}, `${a.ignoredTx2.length} campo${a.ignoredTx2.length > 1 ? 's' : ''} do TX2 fora do leiaute da NF-e (ignorado${a.ignoredTx2.length > 1 ? 's' : ''})`),
    h('p', {}, 'São campos que o sistema gera para outros documentos (NFS-e, por exemplo) ou nomes sem o ID do leiaute. Não entram no XML.'),
    h('code', {}, a.ignoredTx2.map((x) => x.field).join(', ')))) : showXml ? h('div', { class: 'src-foot' }, 'XML montado pelo validador a partir do TX2, para conferir a estrutura. O componente de emissão pode formatar alguns valores de outro jeito.') : h('div', { hidden: true });
  return h('section', { class: 'source', 'aria-label': 'Arquivo' }, head, edits, code, ign);
}

function correctedName() {
  const n = S.fileName && !S.fileName.includes(' ') ? S.fileName : 'nota' + (S.results?.[0]?.kind === 'tx2' ? '.tx2' : '.xml');
  return n.replace(/(\.\w+)?$/, (ext) => '-corrigido' + (ext || ''));
}

function focusLine(n: number) {
  if (S.tab !== 'source') { S.tab = 'source'; render(); }
  const row = document.getElementById('l' + n);
  if (!row) return;
  document.querySelectorAll('.ln.focus').forEach((e) => e.classList.remove('focus'));
  row.classList.add('focus');
  row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function focusCard(n: number) {
  const c = document.querySelector<HTMLElement>(`.card[data-line="${n}"]`);
  if (!c) return;
  c.scrollIntoView({ block: 'center', behavior: 'smooth' });
  c.classList.add('flash');
  setTimeout(() => c.classList.remove('flash'), 1400);
}

function render() {
  const a = S.results?.[S.note];
  const exampleLabel = S.example ? EXAMPLE_LABELS.find(([f]) => f === S.example)?.[1] : undefined;
  app.replaceChildren(
    topBar(),
    h('main', { class: 'wrap' },
      S.example && a ? h('div', { class: 'sample-note' },
        h('span', {}, `Exemplo carregado: ${exampleLabel ?? S.example} (dados fictícios).`),
        h('button', { class: 'btn small primary', type: 'button', onclick: () => fileInput.click() }, 'Validar meu arquivo'),
        h('span', {}, 'ou arraste o arquivo para esta página, ou cole com Ctrl+V.')) : null,
      S.busy && !a ? h('div', { class: 'busy', role: 'status' }, 'Validando...') : null,
      S.error ? h('div', { class: 'card' }, stamp(undefined, 'erro'), h('h3', {}, 'O validador falhou'), h('div', { class: 'meta' }, S.error)) : null,
      !a && !S.busy ? inputArea() : null,
      a ? summaryBlock(a) : null,
      a ? h('div', { class: 'cols' }, findingsBlock(a), sourceBlock(a)) : null,
      h('footer', { class: 'foot' },
        h('p', {}, 'Confere o schema oficial da NF-e 4.00 (PL_010, com IBS/CBS), as contas da nota e regras de coerência. Não consulta a SEFAZ: cadastro de contribuinte, situação da chave e regras específicas de cada UF podem rejeitar uma nota que passou aqui.'),
        h('p', {}, 'Correções de cálculo mostram o valor que fecha a conta com os outros campos. O validador não sugere CST, CFOP nem alíquota.'),
      ),
    ),
  );
  if (S.busy && a) document.querySelector('.summary')?.setAttribute('aria-busy', 'true');
}

/* ------------------------------------------------------------------ */
/* Arrastar, colar, iniciar                                            */
/* ------------------------------------------------------------------ */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.querySelector('.drop')?.classList.add('over'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.querySelector('.drop')?.classList.remove('over'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  const f = e.dataTransfer?.files?.[0];
  if (f) await load(await readFile(f), f.name);
  else {
    const t = e.dataTransfer?.getData('text/plain');
    if (t?.trim()) { sourceIsLatin1 = false; await load(t, 'conteúdo arrastado'); }
  }
});
window.addEventListener('paste', async (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt && (tgt.tagName === 'TEXTAREA' || tgt.tagName === 'INPUT')) return;
  const t = e.clipboardData?.getData('text/plain');
  if (t && t.trim().length > 20) { e.preventDefault(); sourceIsLatin1 = false; await load(t, 'conteúdo colado'); }
});

// abre com um exemplo para mostrar o que a ferramenta faz
const first = 'erro-225-cenq-vazio.tx2';
render();
if (examples.has(first)) load(examples.get(first)!, first, first);
