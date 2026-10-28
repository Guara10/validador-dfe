import type { XNode } from '../types';

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Gera o XML com uma tag por linha e anota em cada nó a linha em que ficou.
 * O conteúdo das folhas é mantido byte a byte (raw), então espaços extras
 * e caracteres inválidos continuam lá para o schema acusar.
 * `fromValues` usa o valor decodificado (nós montados a partir do TX2).
 */
export function formatXml(root: XNode, opts: { declaration?: boolean; fromValues?: boolean } = {}): { text: string; byLine: Map<number, XNode> } {
  const out: string[] = [];
  const byLine = new Map<number, XNode>();
  if (opts.declaration !== false) out.push('<?xml version="1.0" encoding="UTF-8"?>');
  const walk = (n: XNode, depth: number) => {
    const ind = '  '.repeat(depth);
    const q = n.prefix ? `${n.prefix}:${n.name}` : n.name;
    const at = n.attrs.map((a) => ` ${a.name}="${opts.fromValues ? escAttr(a.value) : a.raw}"`).join('');
    if (n.opaque !== undefined) {
      out.push(ind + n.opaque.replace(/\r?\n\s*/g, ''));
      n.fmtLine = n.fmtEndLine = out.length;
      byLine.set(out.length, n);
      return;
    }
    if (!n.children.length) {
      const body = opts.fromValues ? escText(n.text ?? '') : n.raw ?? '';
      out.push(`${ind}<${q}${at}>${body}</${q}>`);
      n.fmtLine = n.fmtEndLine = out.length;
      byLine.set(out.length, n);
      return;
    }
    out.push(`${ind}<${q}${at}>`);
    n.fmtLine = out.length;
    byLine.set(out.length, n);
    for (const c of n.children) walk(c, depth + 1);
    out.push(`${ind}</${q}>`);
    n.fmtEndLine = out.length;
    byLine.set(out.length, n);
  };
  walk(root, 0);
  return { text: out.join('\n') + '\n', byLine };
}
