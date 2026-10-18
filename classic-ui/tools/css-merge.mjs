// Build "classic" CSS: take SillyTavern's version of each shared CSS file and append
// only the SillyBunny rules that target SillyBunny-only elements (selectors whose
// classes/ids never appear in upstream SillyTavern).
import fs from 'fs';
import path from 'path';
import postcss from 'postcss';
import selParser from 'postcss-selector-parser';

const [,, stRoot, sbRoot, outRoot, ...files] = process.argv;

// Corpus of identifiers known to upstream ST (html/js/css under public/)
const corpus = new Set();
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['lib', 'webfonts', 'img', 'locales'].includes(e.name)) walk(p); continue; }
    if (!/\.(html|js|css|json)$/.test(e.name)) continue;
    const s = fs.readFileSync(p, 'utf8');
    for (const m of s.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) corpus.add(m[0]);
  }
}
walk(path.join(stRoot, 'public'));

function isSbOnlyNode(n) {
  if ((n.type === 'class' || n.type === 'id') && !corpus.has(n.value)) return true;
  if (n.type === 'attribute' && /^data-sb|^data-ica|^data-agent/.test(n.attribute)) return true;
  return false;
}

// subjectOnly: only the element the rule styles (last compound selector) decides, so SillyBunny
// restyles of SillyTavern controls inside SillyBunny wrappers are dropped.
function selectorIsSbOnly(sel, subjectOnly = false) {
  let sbOnly = false;
  try {
    selParser(root => {
      root.each(selector => {
        let nodes = selector.nodes;
        if (subjectOnly) {
          const last = nodes.map(n => n.type).lastIndexOf('combinator');
          nodes = nodes.slice(last + 1);
        }
        for (const n of nodes) {
          if (isSbOnlyNode(n)) sbOnly = true;
          if (n.type === 'pseudo' && n.nodes?.length) n.walk(c => { if (!subjectOnly && isSbOnlyNode(c)) sbOnly = true; });
        }
        if (!subjectOnly) selector.walk(n => { if (isSbOnlyNode(n)) sbOnly = true; });
      });
    }).processSync(sel);
  } catch { /* ignore */ }
  return sbOnly;
}

function wrapperChain(node) {
  const chain = [];
  let p = node.parent;
  while (p && p.type !== 'root') { chain.unshift(p); p = p.parent; }
  return chain;
}

const report = {};
for (const rel of files) {
  const extractOnly = rel.startsWith('extract:');
  const spec = rel.replace(/^extract:/, '');
  const [srcRel, dstRel] = spec.includes('=>') ? spec.split('=>') : [spec, spec];
  const stPath = path.join(stRoot, 'public', srcRel);
  const stCss = !extractOnly && fs.existsSync(stPath) ? fs.readFileSync(stPath, 'utf8') : '';
  const sbCss = fs.readFileSync(path.join(sbRoot, 'public', srcRel), 'utf8');
  const stAst = postcss.parse(stCss);
  const sbAst = postcss.parse(sbCss);

  const stVars = new Set();
  stAst.walkDecls(/^--/, d => stVars.add(d.prop));
  postcss.parse(fs.readFileSync(path.join(stRoot, 'public', 'style.css'), 'utf8')).walkDecls(/^--/, d => stVars.add(d.prop));
  const stKeyframes = new Set();
  stAst.walkAtRules('keyframes', a => stKeyframes.add(a.params));
  const stImports = new Set();
  stAst.walkAtRules('import', a => stImports.add(a.params.replace(/\?v=[^)'"]*/, '')));

  const out = postcss.root();
  const extraVars = [];
  const extraImports = [];
  let kept = 0, dropped = 0;

  sbAst.walkAtRules('import', a => { if (!stImports.has(a.params.replace(/\?v=[^)'"]*/, ''))) extraImports.push(a.toString() + ';'); });
  sbAst.walkDecls(/^--/, d => {
    if (d.parent.type === 'rule' && /^(:root|body|html)$/.test(d.parent.selector.trim()) && !stVars.has(d.prop) && d.parent.parent.type === 'root') {
      extraVars.push(`    ${d.prop}: ${d.value};`);
    }
  });
  sbAst.walkAtRules('keyframes', a => {
    if (!stKeyframes.has(a.params) && a.parent.type === 'root') { out.append(a.clone()); kept++; }
  });
  sbAst.walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    // SillyBunny's desktop split-pane layouts (World Info, Prompt Manager editors) are turned off in the classic UI.
    if (wrapperChain(rule).some(w => w.type === 'atrule' && /min-width:\s*961px/.test(w.params))) { dropped++; return; }
    const sels = rule.selectors.filter(sel => selectorIsSbOnly(sel, extractOnly));
    if (!sels.length) { dropped++; return; }
    kept++;
    const clone = rule.clone({ selectors: sels });
    clone.walkRules(r => { if (r !== clone) r.remove(); }); // nested rules handled separately
    let node = clone;
    for (const w of wrapperChain(rule).reverse()) {
      if (w.type === 'rule') { node = null; break; } // CSS nesting inside rule: skip (rare)
      const wc = w.clone(); wc.removeAll(); wc.append(node); node = wc;
    }
    if (node) out.append(node);
  });

  let result = (stCss ? stCss.trimEnd() + '\n\n' : '') + `/* ===== Classic UI fork: SillyBunny-only rules from ${srcRel} (auto-extracted, see tools/css-merge.mjs) ===== */\n`;
  if (extraVars.length) result += ':root {\n' + extraVars.join('\n') + '\n}\n';
  result += out.toString() + '\n';
  // @import must be at top
  if (extraImports.length && !extractOnly) {
    const charset = result.match(/^@charset[^;]*;\s*/);
    result = charset
        ? charset[0] + extraImports.join('\n') + '\n' + result.slice(charset[0].length)
        : extraImports.join('\n') + '\n' + result;
  }
  const outPath = path.join(outRoot, 'public', dstRel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (extractOnly && fs.existsSync(outPath) && process.env.APPEND) fs.appendFileSync(outPath, '\n' + result); else fs.writeFileSync(outPath, result);
  report[rel] = { kept, dropped, vars: extraVars.length, imports: extraImports.length };
}
console.log(JSON.stringify(report, null, 1));
