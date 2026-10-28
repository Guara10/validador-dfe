# Validador DF-e

Valida **XML e TX2 de NF-e/NFC-e** direto no navegador e explica cada problema em português: em que linha está, qual valor foi encontrado, o que o leiaute espera e, quando dá para calcular, o valor corrigido.

Nasceu do suporte técnico a um ERP fiscal: a SEFAZ devolve "225 – Falha no Schema XML" sem dizer onde, e o erro real costuma estar num campo vazio ou numa conta que não fecha dentro de um TX2 de centenas de linhas.

## O que ele confere

**Schema oficial (rejeição 225).** O XML é validado com o XSD oficial da NF-e 4.00 (PL_010, já com os grupos de IBS/CBS), usando o próprio libxml2 compilado em WebAssembly. As mensagens do libxml2 são traduzidas:

| libxml2 diz | O validador mostra |
|---|---|
| `Element 'cEnq': [facet 'pattern'] The value '' ...` | Campo cEnq vazio. É obrigatório dentro de `<IPI>`: preencha ou não gere o grupo. |
| `Element 'mod': This element is not expected. Expected is ( natOp )` | Falta a tag `<natOp>` em `<ide>`. |
| `[facet 'pattern'] The value '1.500,00' ...` | Número com vírgula. Valor corrigido: `1500.00`. |

O libxml2 (como a SEFAZ) para de validar um grupo no primeiro erro. Uma varredura própria confere todos os campos contra o dicionário extraído do XSD, então os erros aparecem todos de uma vez.

**Contas.** Totais contra a soma dos itens (531, 532, 564, 610), `qCom × vUnCom` (629), ICMS, diferimento do CST 51, FCP, IPI, PIS/COFINS, IBS/CBS por esfera e totais de IBS/CBS (1080). A diferença é mostrada em reais, com o valor que fecha a conta.

**Coerência.** Chave de acesso contra os campos da nota (502) e dígito verificador (inclusive CNPJ alfanumérico), CFOP contra tipo e destino da operação (518, 519), não contribuinte (508, 696), CST 51 sem `pRedBC`/`pDif` (929), item sem grupo IBS/CBS, fuso horário errado para a UF (703), peso fora de escala, duplicatas e pagamentos que não fecham.

**O que ele não faz:** não consulta a SEFAZ (cadastro, situação da chave, regras próprias de cada UF) e **não sugere CST, CFOP nem alíquota**. Correções de cálculo mostram o valor que fecha a conta com os demais campos; se o valor do arquivo estiver certo, o erro está em algum campo usado no cálculo.

## TX2

O TX2 (formato `campo_ID=valor`, com `INCLUIR`/`INCLUIRITEM`/`SALVARITEM`/`SALVAR`) é convertido em XML usando o próprio XSD como guia:

1. A letra do ID diz o grupo do leiaute (`N` = ICMS, `O` = IPI, `UB` = IBS/CBS...).
2. Quando a tag existe em vários grupos de escolha (`ICMS00` × `ICMS51`, `IPITrib` × `IPINT`, `PISAliq` × `PISNT`), o ramo é decidido pelo campo com lista de valores (CST/CSOSN).
3. Ambiguidades que sobram (o `vDif` do IBS UF, do IBS Município e da CBS) são resolvidas pela ordem dos IDs, ancorada nos campos sem ambiguidade.
4. O XML montado passa pelas mesmas validações, e cada erro volta para a **linha e o campo do TX2**. Se a tag obrigatória faltou porque o campo estava vazio no TX2, a mensagem diz isso.

Campos que não pertencem ao leiaute (usados pelo sistema para outros documentos) são listados e ignorados.

## Como usar

- **Arquivo único, offline:** `dist/index.html` funciona com dois cliques, sem servidor e sem internet. O wasm, os schemas e o dicionário vão embutidos (~1,8 MB).
- **Web:** publicado no GitHub Pages pelo workflow em `.github/workflows/pages.yml`.

Nada sai do navegador: o arquivo é lido localmente.

Na tela: abra, arraste ou cole (Ctrl+V) o arquivo. Cada problema tem link para a linha, botão para copiar o valor corrigido e, quando o alvo é claro, **Aplicar no arquivo** (a nota é validada de novo em seguida). **Copiar relatório** gera um texto pronto para colar no chamado ou mandar para o programador.

## Desenvolvimento

```bash
npm install
npm run dev        # servidor local
npm test           # testes com os exemplos de /exemplos
npm run build      # gera dist/index.html (arquivo único)
npm run check -- exemplos/erro-calculos.tx2   # diagnóstico no terminal
```

Para atualizar o leiaute: troque os XSDs em `schemas/nfe/` e rode `npm run schemas`. O dicionário de campos (`src/generated/nfe-dict.json`) e os schemas enxutos são gerados a partir deles.

### Estrutura

```
schemas/nfe/            XSDs oficiais (PL_010)
scripts/build-schemas   XSD -> dicionário de campos + schemas sem anotações
src/core/xml            parser com número de linha e formatador
src/core/xsd            tradução dos erros do libxml2 + varredura completa
src/core/rules          contas e regras de coerência
src/core/tx2            leitura do TX2 e montagem do XML guiada pelo XSD
src/browser             xmllint (wasm) num Web Worker criado de um Blob
src/ui                  interface
exemplos/               notas fictícias usadas nos testes e no menu de exemplos
```

## Próximos passos

- Visualização da nota (DANFE) como módulo, reaproveitando o mesmo leitor.
- CT-e e DACTE.
- NFS-e padrão nacional (já existe um visualizador separado).

## Créditos

- Schemas da NF-e: Portal Nacional da NF-e (obtidos via [nfephp-org/sped-nfe](https://github.com/nfephp-org/sped-nfe)).
- [xmllint-wasm](https://github.com/noppa/xmllint-wasm) (MIT), sobre o [libxml2](https://gitlab.gnome.org/GNOME/libxml2) (MIT).

Os exemplos usam dados fictícios. Não versione notas de clientes: a pasta `privado/` está no `.gitignore` para isso.
