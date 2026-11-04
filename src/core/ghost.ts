import type { Ghost, XNode } from './types';
import type { Dict } from './dict';
import { dictPath } from './xml/parse';

/**
 * Calcula onde uma tag que falta entra no XML exibido (formatado ou montado do TX2),
 * usando a ordem do XSD: antes do primeiro irmão que vem depois dela no leiaute,
 * ou antes do fechamento do grupo.
 */
export function ghostFor(dict: Dict, parent: XNode | undefined, name: string, text?: string): Ghost | undefined {
  if (!parent || parent.fmtLine === undefined || !parent.children.length) return undefined;
  const dn = dict.get(dictPath(parent) + '/' + name);
  const order = (n: XNode) => dict.get(dictPath(n))?.o ?? -1;
  let depth = 1;
  for (let c = parent.parent; c; c = c.parent) depth++;
  const group = !!dn?.c?.length;
  const next = dn ? parent.children.find((c) => order(c) > dn.o) : undefined;
  const afterLine = next?.fmtLine !== undefined ? next.fmtLine - 1 : (parent.fmtEndLine ?? parent.fmtLine) - 1;
  return { afterLine, depth, group, text: text ?? `<${name}>…</${name}>` };
}
