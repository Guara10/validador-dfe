// Validação XSD no navegador com o libxml2 (xmllint) compilado em WebAssembly.
// Roda num Web Worker criado a partir de um Blob, sem nenhum fetch: funciona
// em file:// (arquivo aberto com dois cliques), no GitHub Pages e em páginas com CSP restrita.
import glueSource from 'xmllint-wasm/xmllint-browser.mjs?raw';
import wasmB64 from 'virtual:xmllint-wasm-b64';
import type { XsdRunner } from '../core/analyze';
import type { RawXsdError } from '../core/xsd/translate';

const glue = glueSource.slice(0, glueSource.indexOf(';(function initWorker()'));

/** Código do worker: a cola do emscripten + um protocolo de mensagens simples. */
const workerBody = `
${glue}
;(function(){
  var compiled = null, schemas = null;
  async function run(xml, entry) {
    var stdout = '', stderr = '', done = false, resolve;
    var p = new Promise(function(r){ resolve = r; });
    function finish(code){ if (done) return; done = true; resolve({ code: code, stdout: stdout, stderr: stderr }); }
    var files = [{ fileName: 'nota.xml', contents: xml }];
    for (var k in schemas) files.push({ fileName: k, contents: schemas[k] });
    try {
      await Module({
        inputFiles: files,
        arguments: ['--schema', entry, '--noout', 'nota.xml'],
        print: function(t){ stdout += t + '\\n'; },
        printErr: function(t){ stderr += t + '\\n'; },
        onExit: finish,
        onAbort: function(r){ stderr += 'WASM Abort: ' + r; finish(-1); },
        wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 2048 }),
        instantiateWasm: function(imports, cb){
          WebAssembly.instantiate(compiled, imports).then(function(inst){ cb(inst, compiled); });
          return {};
        }
      });
    } catch (e) {
      if (e && e.name === 'ExitStatus') finish(e.status); else { stderr += String(e); finish(-1); }
    }
    return p;
  }
  self.onmessage = async function(ev){
    var d = ev.data;
    if (d.type === 'init') {
      try { compiled = await WebAssembly.compile(d.wasm); schemas = d.schemas; self.postMessage({ id: d.id, ok: true }); }
      catch (e) { self.postMessage({ id: d.id, error: String(e) }); }
      return;
    }
    var r = await run(d.xml, d.entry);
    self.postMessage({ id: d.id, result: r });
  };
})();
`;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseXmllintOutput(stderr: string): RawXsdError[] {
  const out: RawXsdError[] = [];
  for (const line of stderr.split('\n')) {
    if (!line.trim() || / validates$| fails to validate$/.test(line.trim())) continue;
    const m = /^nota\.xml:(\d+):\s*(.*)$/.exec(line);
    if (m) out.push({ line: +m[1], message: m[2] });
    else if (/error|WASM/i.test(line)) out.push({ line: null, message: line });
  }
  return out;
}

export function createBrowserRunner(schemas: Record<string, string>): XsdRunner {
  const url = URL.createObjectURL(new Blob([workerBody], { type: 'text/javascript' }));
  const worker = new Worker(url);
  let seq = 0;
  const pending = new Map<number, (v: any) => void>();
  worker.onmessage = (e) => {
    const cb = pending.get(e.data.id);
    if (cb) { pending.delete(e.data.id); cb(e.data); }
  };
  const call = (msg: any, transfer: Transferable[] = []) =>
    new Promise<any>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      worker.postMessage({ ...msg, id }, transfer);
    });
  const wasm = b64ToBytes(wasmB64);
  const ready = call({ type: 'init', wasm: wasm.buffer, schemas }, [wasm.buffer]).then((r) => {
    if (r.error) throw new Error('Falha ao iniciar o validador de schema: ' + r.error);
  });
  return {
    async validate(xml, entry) {
      await ready;
      const r = await call({ type: 'run', xml, entry });
      const { code, stderr } = r.result;
      if (code === 0) return [];
      const errs = parseXmllintOutput(stderr);
      if (!errs.length && code !== 3 && code !== 4) return [{ line: null, message: 'O validador de schema falhou: ' + stderr.slice(0, 300) }];
      return errs;
    },
  };
}
