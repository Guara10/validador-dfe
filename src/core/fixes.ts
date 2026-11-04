import type { Finding } from './types';

/**
 * Aplicação das correções no texto do arquivo (mesmo código usado pela tela e pelos testes).
 * Cada função devolve o texto novo, ou null se a linha esperada não está lá.
 */

/** Troca o valor de um campo (TX2: campo=valor; XML: conteúdo da tag ou o Id da chave). */
export function valueFixFor(f: Finding, kind: 'xml' | 'tx2'): ((text: string) => string | null) | null {
  if (!f.fix?.value || !f.line) return null;
  const value = f.fix.value;
  if (kind === 'tx2') {
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

/** Prévias que dá para inserir sem digitar nada: valor conhecido e ID do leiaute conhecido. */
export const insertable = (f: Finding) => (f.ghosts ?? []).filter((g) => !g.fill && !g.text.includes('…') && !/_\?=/.test(g.text));

/** Insere as linhas/tags que faltam. */
export function insertFixFor(f: Finding): ((text: string) => string | null) | null {
  if (!insertable(f).length) return null;
  return (text) => {
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const gs = [...insertable(f)].sort((x, y) => y.afterLine - x.afterLine);
    for (const g of gs) {
      if (lines[g.afterLine - 1] === undefined) return null;
      const add = g.format === 'tx2' ? g.text.split('\n') : g.text.split('\n').map((t) => '  '.repeat(g.depth) + t);
      lines.splice(g.afterLine, 0, ...add);
    }
    return lines.join(nl);
  };
}
