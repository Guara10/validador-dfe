// Gera, a partir dos XSDs oficiais:
//  1) src/generated/<doc>-dict.json  -> árvore de campos (ordem, obrigatoriedade, formato, descrição)
//  2) src/generated/<doc>-schemas.json -> XSDs sem <xs:annotation> (menores) para o validador
//
// Uso: node scripts/build-schemas.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const XS = 'http://www.w3.org/2001/XMLSchema';

const DOCS = [
  {
    id: 'nfe',
    dir: 'schemas/nfe',
    rootType: 'TNFe',
    rootName: 'NFe',
    // arquivo principal por elemento raiz do XML
    entry: { NFe: 'nfe_v4.00.xsd', nfeProc: 'procNFe_v4.00.xsd', enviNFe: 'enviNFe_v4.00.xsd' },
  },
];

const kids = (el) => {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
};
const xs = (el, name) => kids(el).filter((k) => k.namespaceURI === XS && k.localName === name);
const local = (q) => (q ? q.split(':').pop() : q);
const docOf = (el) => {
  const ann = xs(el, 'annotation')[0];
  if (!ann) return '';
  const d = xs(ann, 'documentation')[0];
  return d ? d.textContent.replace(/\s+/g, ' ').trim() : '';
};

for (const D of DOCS) {
  const dir = join(ROOT, D.dir);
  const files = readdirSync(dir).filter((f) => f.endsWith('.xsd'));
  const simple = {}, complex = {};
  const stripped = {};

  for (const f of files) {
    const txt = readFileSync(join(dir, f), 'utf8').replace(/^\uFEFF/, '');
    const doc = new DOMParser().parseFromString(txt, 'text/xml');
    const schema = doc.documentElement;
    if (!f.startsWith('xmldsig')) {
      for (const st of xs(schema, 'simpleType')) simple[st.getAttribute('name')] = st;
      for (const ct of xs(schema, 'complexType')) complex[ct.getAttribute('name')] = ct;
    }
    // versão enxuta para validação (DOM separado: o original segue com as descrições)
    const sdoc = new DOMParser().parseFromString(txt, 'text/xml');
    const anns = sdoc.getElementsByTagNameNS(XS, 'annotation');
    for (let i = anns.length - 1; i >= 0; i--) anns[i].parentNode.removeChild(anns[i]);
    stripped[f] = new XMLSerializer()
      .serializeToString(sdoc)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\n\s*\n/g, '\n');
  }

  // ---------- facets de tipos simples ----------
  function facetsOfRestriction(r, acc) {
    const base = local(r.getAttribute('base'));
    if (base && simple[base]) collectSimple(simple[base], acc);
    else acc.b = base; // tipo XSD nativo (string, token, decimal...)
    // padrões irmãos na mesma restrição valem como "OU"; padrões de níveis diferentes de derivação, como "E"
    const sib = [];
    for (const k of kids(r)) {
      const v = k.getAttribute('value');
      switch (k.localName) {
        case 'pattern': sib.push(v); break;
        case 'enumeration': {
          (acc.e ||= []).push(v);
          const d = docOf(k);
          if (d) (acc.ed ||= {})[v] = d;
          break;
        }
        case 'minLength': acc.mn = +v; break;
        case 'maxLength': acc.mx = +v; break;
        case 'length': acc.len = +v; break;
        case 'totalDigits': acc.td = +v; break;
        case 'fractionDigits': acc.fd = +v; break;
        case 'minInclusive': acc.minI = v; break;
        case 'maxInclusive': acc.maxI = v; break;
      }
    }
    if (sib.length) (acc.p ||= []).push(sib.length === 1 ? sib[0] : sib.map((x) => `(?:${x})`).join('|'));
    return acc;
  }
  function collectSimple(st, acc = {}) {
    const r = xs(st, 'restriction')[0];
    if (r) {
      const own = facetsOfRestriction(r, {});
      // facets do tipo mais específico prevalecem
      Object.assign(acc, own);
      if (!acc.tn && st.getAttribute('name')) acc.tn = st.getAttribute('name');
      if (!acc.td0 && docOf(st)) acc.td0 = docOf(st);
    }
    return acc;
  }

  // ---------- árvore ----------
  let order = 0;
  const flat = [];
  function elementNode(el, parentPath) {
    const ref = el.getAttribute('ref');
    if (ref) {
      const n = local(ref);
      const node = { n, k: 'e', o: order++, min: +(el.getAttribute('minOccurs') || 1), max: el.getAttribute('maxOccurs') || '1', d: 'Assinatura digital (XMLDSig)', opaque: 1 };
      node.path = parentPath ? parentPath + '/' + n : n;
      flat.push(node);
      return node;
    }
    const name = el.getAttribute('name');
    const path = parentPath ? parentPath + '/' + name : name;
    const node = {
      n: name, k: 'e', o: order++,
      min: +(el.getAttribute('minOccurs') ?? 1),
      max: el.getAttribute('maxOccurs') || '1',
      d: docOf(el),
      path,
    };
    flat.push(node);
    const typeName = local(el.getAttribute('type'));
    let ct = xs(el, 'complexType')[0];
    let st = xs(el, 'simpleType')[0];
    if (typeName && complex[typeName]) ct = complex[typeName];
    if (typeName && simple[typeName]) st = simple[typeName];
    if (ct) {
      // atributos primeiro: no MOC o ID do atributo vem antes dos filhos (ex.: obsCont xCampo Z05, xTexto Z06)
      const at = attributesOf(ct, path);
      node.c = complexContent(ct, path);
      if (at.length) node.a = at;
      if (typeName) node.tn = typeName;
    } else if (st) {
      node.f = collectSimple(st);
      if (typeName) node.f.tn = typeName;
    } else if (typeName) {
      node.f = { b: typeName };
    }
    if (node.f && !node.d && node.f.td0) node.d = node.f.td0;
    if (node.f) delete node.f.td0;
    return node;
  }
  function attributesOf(ct, path) {
    return xs(ct, 'attribute').map((a) => {
      const name = a.getAttribute('name');
      const node = { n: name, k: 'a', o: order++, min: a.getAttribute('use') === 'required' ? 1 : 0, max: '1', d: docOf(a), path: path + '/@' + name };
      const tn = local(a.getAttribute('type'));
      const st = xs(a, 'simpleType')[0] || (tn && simple[tn]);
      if (st) { node.f = collectSimple(st); if (tn) node.f.tn = tn; delete node.f.td0; }
      else if (tn) node.f = { b: tn };
      flat.push(node);
      return node;
    });
  }
  function particle(p, path) {
    if (p.localName === 'element') return elementNode(p, path);
    if (p.localName === 'sequence' || p.localName === 'choice') {
      const items = kids(p).filter((k) => k.namespaceURI === XS && ['element', 'sequence', 'choice'].includes(k.localName)).map((k) => particle(k, path));
      return { [p.localName === 'sequence' ? 's' : 'ch']: items, min: +(p.getAttribute('minOccurs') ?? 1), max: p.getAttribute('maxOccurs') || '1' };
    }
    return null;
  }
  function complexContent(ct, path) {
    const top = kids(ct).filter((k) => k.namespaceURI === XS && ['sequence', 'choice'].includes(k.localName));
    return top.map((t) => particle(t, path));
  }

  // raiz: <NFe> do tipo TNFe
  const root = { n: D.rootName, k: 'e', o: order++, min: 1, max: '1', d: docOf(complex[D.rootType]), path: D.rootName, tn: D.rootType };
  root.c = complexContent(complex[D.rootType], D.rootName);
  const ra = attributesOf(complex[D.rootType], D.rootName);
  if (ra.length) root.a = ra;

  // limpar campos vazios
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === 'object') {
      const r = {};
      for (const [k, v] of Object.entries(o)) {
        if (v === '' || v === undefined) continue;
        if (k === 'min' && v === 1) continue;
        if (k === 'max' && v === '1') continue;
        if (k === 'd' && typeof v === 'string') { r.d = v.length > 400 ? v.slice(0, 397) + '...' : v; continue; }
        r[k] = clean(v);
      }
      return r;
    }
    return o;
  };

  mkdirSync(join(ROOT, 'src/generated'), { recursive: true });
  writeFileSync(join(ROOT, `src/generated/${D.id}-dict.json`), JSON.stringify(clean(root)));
  writeFileSync(join(ROOT, `src/generated/${D.id}-schemas.json`), JSON.stringify({ entry: D.entry, files: stripped }));
  const sz = (f) => (readFileSync(join(ROOT, 'src/generated', f)).length / 1024).toFixed(0) + ' KB';
  console.log(`${D.id}: ${flat.length} campos | dict ${sz(D.id + '-dict.json')} | schemas ${sz(D.id + '-schemas.json')}`);
}
