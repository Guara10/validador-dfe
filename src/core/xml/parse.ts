import type { XNode } from '../types';

export class XmlSyntaxError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(message);
  }
}

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

const OPAQUE = new Set(['Signature']);

/**
 * Parser XML enxuto, tolerante o suficiente para documentos fiscais.
 * Guarda a linha de cada elemento e preserva o texto bruto das folhas,
 * para que a validação veja exatamente o que estava no arquivo.
 */
export function parseXml(input: string): XNode {
  const src = input.replace(/^﻿/, '');
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const advanceTo = (to: number) => {
    for (let k = i; k < to; k++) if (src.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
    i = to;
  };
  const err = (msg: string): never => {
    throw new XmlSyntaxError(msg, line, i - lineStart + 1);
  };

  const stack: XNode[] = [];
  let root: XNode | undefined;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      const rest = src.slice(i);
      if (rest.trim()) err('Texto fora de qualquer tag no fim do arquivo.');
      break;
    }
    // texto entre tags
    if (lt > i) {
      const raw = src.slice(i, lt);
      const top = stack[stack.length - 1];
      if (raw.trim()) {
        if (!top) { advanceTo(lt); err('Há texto fora da tag raiz.'); }
        top!.raw = (top!.raw ?? '') + raw;
      } else if (top && top.children.length === 0) {
        // pode ser conteúdo de espaço de uma folha; guarda provisoriamente
        top.raw = (top.raw ?? '') + raw;
      }
      advanceTo(lt);
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) err('Comentário <!-- sem fechamento -->.');
      advanceTo(end + 3);
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i);
      if (end < 0) err('Bloco CDATA sem fechamento.');
      const top = stack[stack.length - 1];
      if (!top) err('CDATA fora da tag raiz.');
      top!.raw = (top!.raw ?? '') + src.slice(i, end + 3);
      advanceTo(end + 3);
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i);
      if (end < 0) err('Instrução <? sem fechamento ?>.');
      if (root || stack.length) {
        if (src.slice(i, i + 5).toLowerCase() === '<?xml') err('Declaração <?xml ... ?> repetida no meio do arquivo (dois XMLs colados?).');
      }
      advanceTo(end + 2);
      continue;
    }
    if (src.startsWith('<!', i)) {
      const end = src.indexOf('>', i);
      if (end < 0) err('Declaração <! sem fechamento.');
      advanceTo(end + 1);
      continue;
    }
    if (src[i + 1] === '/') {
      // tag de fechamento
      const end = src.indexOf('>', i);
      if (end < 0) err('Tag de fechamento sem ">".');
      const qname = src.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top) err(`Tag de fechamento </${qname}> sem abertura correspondente.`);
      const name = qname.includes(':') ? qname.split(':')[1] : qname;
      if (top!.name !== name) err(`A tag <${top!.prefix ? top!.prefix + ':' : ''}${top!.name}> (aberta na linha ${top!.line}) foi fechada com </${qname}>.`);
      if (top!.children.length) delete top!.raw;
      if (top!.raw !== undefined) top!.text = decodeRaw(top!.raw);
      advanceTo(end + 1);
      continue;
    }
    // tag de abertura
    const startLine = line;
    let j = i + 1;
    const nameMatch = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/.exec(src.slice(j, j + 200));
    if (!nameMatch) err('Nome de tag inválido após "<".');
    const qname = nameMatch![0];
    j += qname.length;
    const node: XNode = {
      name: qname.includes(':') ? qname.split(':')[1] : qname,
      prefix: qname.includes(':') ? qname.split(':')[0] : undefined,
      attrs: [],
      children: [],
      line: startLine,
    };
    // atributos
    let selfClose = false;
    for (;;) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (j >= src.length) { advanceTo(j); err(`Tag <${qname}> sem ">".`); }
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/' && src[j + 1] === '>') { j += 2; selfClose = true; break; }
      const am = /^([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)\s*=\s*(["'])/.exec(src.slice(j, j + 300));
      if (!am) { advanceTo(j); err(`Atributo malformado na tag <${qname}>.`); }
      j += am![0].length;
      const q = am![2];
      const close = src.indexOf(q, j);
      if (close < 0) { advanceTo(j); err(`Aspas do atributo ${am![1]} não foram fechadas.`); }
      const raw = src.slice(j, close);
      node.attrs.push({ name: am![1], raw, value: decodeEntities(raw) });
      j = close + 1;
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
      delete parent.raw;
    } else {
      if (root) { advanceTo(j); err('Há mais de uma tag raiz (dois documentos colados?).'); }
      root = node;
    }
    if (OPAQUE.has(node.name) && !selfClose) {
      // guarda o bloco inteiro como está (assinatura não deve ser reformatada)
      const closeTag = `</${qname}>`;
      const end = src.indexOf(closeTag, j);
      if (end < 0) { advanceTo(j); err(`Tag <${qname}> não foi fechada.`); }
      node.opaque = src.slice(i, end + closeTag.length);
      advanceTo(end + closeTag.length);
      continue;
    }
    advanceTo(j);
    if (!selfClose) stack.push(node);
    else node.text = '', node.raw = '';
  }
  if (stack.length) {
    const t = stack[stack.length - 1];
    throw new XmlSyntaxError(`A tag <${t.name}> aberta na linha ${t.line} não foi fechada (arquivo cortado?).`, line, 1);
  }
  if (!root) throw new XmlSyntaxError('Nenhuma tag encontrada. O conteúdo não parece ser XML.', 1, 1);
  return root;
}

function decodeRaw(raw: string): string {
  // CDATA vira texto literal; o resto decodifica entidades
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g, (_, cdata, txt) => (cdata !== undefined ? cdata : decodeEntities(txt)));
}

export function attr(n: XNode | undefined, name: string): string | undefined {
  return n?.attrs.find((a) => a.name === name)?.value;
}
export function child(n: XNode | undefined, name: string): XNode | undefined {
  return n?.children.find((c) => c.name === name);
}
export function childrenNamed(n: XNode | undefined, name: string): XNode[] {
  return n ? n.children.filter((c) => c.name === name) : [];
}
/** Caminho com "*" para qualquer nome: get(det, 'imposto/ICMS/*\/vBC') */
export function select(n: XNode | undefined, path: string): XNode | undefined {
  let cur = n;
  for (const p of path.split('/')) {
    if (!cur) return undefined;
    cur = p === '*' ? cur.children[0] : child(cur, p);
  }
  return cur;
}
export function txt(n: XNode | undefined, path?: string): string | undefined {
  const t = path ? select(n, path) : n;
  return t?.text;
}
export function descendants(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}
/** Caminho legível com índice de repetição: infNFe / det[2] / imposto / ICMS / ICMS51 / vBC */
export function humanPath(n: XNode, stopAt = new Set(['NFe', 'nfeProc', 'enviNFe'])): string {
  const parts: string[] = [];
  let cur: XNode | undefined = n;
  while (cur && !stopAt.has(cur.name)) {
    let label = cur.name;
    if (cur.parent) {
      const same = cur.parent.children.filter((c) => c.name === cur!.name);
      if (same.length > 1 || cur.name === 'det') label += `[${same.indexOf(cur) + 1}]`;
    }
    if (cur.name === 'det') {
      const nItem = attr(cur, 'nItem');
      if (nItem) label = `det[${nItem}]`;
    }
    parts.unshift(label);
    cur = cur.parent;
  }
  return parts.join(' / ');
}
/** Caminho do dicionário (sem índices), relativo à raiz NFe */
export function dictPath(n: XNode): string {
  const parts: string[] = [];
  let cur: XNode | undefined = n;
  while (cur) {
    parts.unshift(cur.name);
    if (cur.name === 'NFe') break;
    cur = cur.parent;
  }
  return parts.join('/');
}
