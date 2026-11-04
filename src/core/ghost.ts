import type { Ghost, XNode } from './types';
import type { Dict, DNode, Group, Particle } from './dict';
import { dictPath } from './xml/parse';

/**
 * Calcula onde uma tag que falta entra no XML exibido (formatado ou montado do TX2),
 * usando a ordem do XSD: antes do primeiro irmão que vem depois dela no leiaute,
 * ou antes do fechamento do grupo.
 */
export function ghostFor(dict: Dict, parent: XNode | undefined, name: string, text?: string, values?: Record<string, string>): Ghost | undefined {
  if (!parent || parent.fmtLine === undefined || !parent.children.length) return undefined;
  const dn = dict.get(dictPath(parent) + '/' + name);
  const order = (n: XNode) => dict.get(dictPath(n))?.o ?? -1;
  let depth = 1;
  for (let c = parent.parent; c; c = c.parent) depth++;
  const group = !!dn?.c?.length;
  const next = dn ? parent.children.find((c) => order(c) > dn.o) : undefined;
  const afterLine = next?.fmtLine !== undefined ? next.fmtLine - 1 : (parent.fmtEndLine ?? parent.fmtLine) - 1;
  return { afterLine, depth, group, text: text ?? (group && dn ? xmlSkeleton(dict, dn, values) : `<${name}>…</${name}>`), format: 'xml', parent, name, values };
}

/** Campos obrigatórios de um grupo (para mostrar o esqueleto de um grupo que falta). */
export function requiredLeaves(dict: Dict, dn: DNode): DNode[] {
  // obrigatórios; de uma escolha (xs:choice) do primeiro nível, usa o primeiro ramo (ex.: gIBSCBS)
  const out: DNode[] = [];
  const walkP = (p: Particle, top: boolean) => {
    if ((p as DNode).n !== undefined) {
      const d = p as DNode;
      if ((d.min ?? 1) === 0) return;
      if (d.c?.length) for (const x of d.c) walkP(x, false);
      else if (d.k === 'e') out.push(d);
      return;
    }
    const g = p as Group;
    if (g.s) { if ((g.min ?? 1) === 0) return; for (const x of g.s) walkP(x, top); }
    else if (g.ch?.length) {
      if ((g.min ?? 1) > 0) walkP(g.ch[0], false);
      // escolha opcional: só a primeira do grupo (no IBSCBS, gIBSCBS); as demais são situações específicas
      else if (top && !usedOptionalChoice) { usedOptionalChoice = true; walkP(g.ch[0], true); }
    }
  };
  let usedOptionalChoice = false;
  for (const p of dn.c ?? []) walkP(p, true);
  return out;
}


/** Esqueleto XML de um grupo que falta: só os obrigatórios, com os valores conhecidos. */
export function xmlSkeleton(dict: Dict, dn: DNode, values?: Record<string, string>): string {
  const leaves = requiredLeaves(dict, dn);
  const lines: string[] = [];
  const open: string[] = [];
  const base = dn.path.split('/').length;
  lines.push(`<${dn.n}>`);
  for (const l of leaves) {
    const chain = l.path.split('/').slice(base, -1);
    let i = 0;
    while (i < open.length && open[i] === chain[i]) i++;
    while (open.length > i) { const t = open.pop()!; lines.push('  '.repeat(open.length + 1) + `</${t}>`); }
    for (; i < chain.length; i++) { lines.push('  '.repeat(open.length + 1) + `<${chain[i]}>`); open.push(chain[i]); }
    lines.push('  '.repeat(open.length + 1) + `<${l.n}>${values?.[l.n] ?? '…'}</${l.n}>`);
  }
  while (open.length) { const t = open.pop()!; lines.push('  '.repeat(open.length + 1) + `</${t}>`); }
  lines.push(`</${dn.n}>`);
  return lines.join('\n');
}
