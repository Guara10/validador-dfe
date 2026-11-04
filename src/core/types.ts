export type Severity = 'erro' | 'aviso' | 'info';
export type Origin = 'schema' | 'calculo' | 'regra' | 'estrutura';

/** Nó de XML com localização na origem e no texto formatado. */
export interface XNode {
  name: string; // nome local, sem prefixo
  prefix?: string;
  attrs: XAttr[];
  children: XNode[];
  parent?: XNode;
  /** texto bruto (com entidades) para folhas */
  raw?: string;
  /** texto decodificado */
  text?: string;
  /** linha no texto original (1-based) */
  line: number;
  /** linha no texto formatado mostrado ao usuário */
  fmtLine?: number;
  fmtEndLine?: number;
  /** linha no TX2 (quando o nó veio de um TX2) */
  tx2Line?: number;
  /** nome do campo no TX2 (ex.: vICMS_N17) */
  tx2Field?: string;
  /** trecho original de nós opacos (ex.: Signature) */
  opaque?: string;
}
export interface XAttr {
  name: string;
  value: string;
  raw: string;
  tx2Line?: number;
  tx2Field?: string;
}

export interface Fix {
  /** explicação curta do que fazer */
  text: string;
  /** valor sugerido, quando dá para calcular */
  value?: string;
}

/** Tag que falta, mostrada na posição em que deve entrar no XML exibido. */
export interface Ghost {
  /** linha do XML exibido depois da qual a tag entra */
  afterLine: number;
  /** nível de indentação (2 espaços por nível) */
  depth: number;
  /** texto da tag, ex.: <pRedBC>0.00</pRedBC> ou <cEnq>…</cEnq> */
  text: string;
  /** é um grupo inteiro (ex.: IBSCBS), não um campo */
  group?: boolean;
  /** a linha já existe (campo vazio no TX2): é para preencher, não inserir */
  fill?: boolean;
  /** formato do texto: tag XML ou linha de TX2 */
  format?: 'xml' | 'tx2';
  /** valores calculados para os campos de um grupo que falta (nome do campo -> valor) */
  values?: Record<string, string>;
  /** de onde saiu o valor (mostrado no card) */
  note?: string;
  /** uso interno: grupo e nome da tag que falta */
  parent?: XNode;
  name?: string;
}

export interface Finding {
  sev: Severity;
  origin: Origin;
  /** código de rejeição provável da SEFAZ, quando conhecido */
  code?: string;
  title: string;
  message: string;
  /** caminho legível: det[2] / imposto / ICMS / ICMS51 / pRedBC */
  path?: string;
  /** linha no texto mostrado (XML formatado ou TX2) */
  line?: number;
  tx2Field?: string;
  found?: string;
  expected?: string;
  fix?: Fix;
  /** descrição oficial do campo (documentação do XSD) */
  doc?: string;
  /** tags que faltam, com a posição no arquivo enviado (XML ou TX2) */
  ghosts?: Ghost[];
  /** para TX2: as mesmas tags no XML montado */
  xmlGhosts?: Ghost[];
}

export interface DocSummary {
  modelo?: string;
  numero?: string;
  serie?: string;
  chave?: string;
  emitente?: string;
  destinatario?: string;
  dhEmi?: string;
  vNF?: string;
  itens?: number;
  tpAmb?: string;
  autorizada?: boolean;
}

export interface Analysis {
  kind: 'xml' | 'tx2';
  /** texto exibido no painel de origem (XML formatado ou TX2 original) */
  source: string;
  /** XML montado a partir do TX2 (só para kind = tx2) */
  generatedXml?: string;
  findings: Finding[];
  summary: DocSummary;
  /** campos do TX2 sem correspondência no leiaute (ignorados) */
  ignoredTx2?: { line: number; field: string }[];
  schemaOk: boolean;
  fatal?: string;
}
