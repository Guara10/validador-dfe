/**
 * Decodifica o arquivo como o sistema gerou: XML com encoding declarado, UTF-8 (com ou sem BOM)
 * ou, se não for UTF-8 válido, Windows-1252 (o "ANSI" dos TX2 gerados no Windows).
 */
export function decodeBytes(buf: ArrayBuffer | Uint8Array): { text: string; latin1: boolean } {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 200));
  const declared = /encoding=["']([^"']+)/i.exec(head)?.[1]?.toLowerCase();
  if (declared && !/utf-?8/.test(declared)) {
    try { return { text: new TextDecoder(declared).decode(bytes), latin1: true }; } catch { /* encoding desconhecido: tenta os outros */ }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''), latin1: false };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), latin1: true };
  }
}
