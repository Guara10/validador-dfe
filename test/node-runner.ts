import { validateXML } from 'xmllint-wasm';
import type { XsdRunner } from '../src/core/analyze';
import { nfeSchemas } from '../src/core/engine-data';

/** Runner para testes em Node, usando o mesmo xmllint compilado em wasm. */
export const nodeRunner: XsdRunner = {
  async validate(xml, entry) {
    const r = await validateXML({
      xml: [{ fileName: 'nota.xml', contents: xml }],
      schema: [{ fileName: entry, contents: nfeSchemas.files[entry] }],
      preload: Object.entries(nfeSchemas.files).filter(([k]) => k !== entry).map(([fileName, contents]) => ({ fileName, contents })),
    });
    return r.errors.map((e) => ({ line: e.loc?.lineNumber ?? null, message: e.message }));
  },
};
