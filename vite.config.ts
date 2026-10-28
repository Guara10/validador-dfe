import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Embute o xmllint.wasm como base64: o HTML final não depende de nenhum arquivo externo. */
function xmllintWasm(): Plugin {
  const id = 'virtual:xmllint-wasm-b64';
  return {
    name: 'xmllint-wasm-b64',
    resolveId: (s) => (s === id ? '\0' + id : undefined),
    load(s) {
      if (s !== '\0' + id) return;
      const file = require.resolve('xmllint-wasm/xmllint.wasm');
      return `export default ${JSON.stringify(readFileSync(file).toString('base64'))};`;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [xmllintWasm(), viteSingleFile()],
  build: { target: 'es2020', outDir: 'dist', reportCompressedSize: false },
});
