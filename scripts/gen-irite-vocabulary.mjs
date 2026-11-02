/**
 * Generate `src/extraction/languages/irite-vocabulary.ts` from the iRite
 * TextMate grammar (`vscode-language-iRite/syntaxes/irite.tmLanguage`).
 *
 * The grammar is the source of truth for WHICH identifiers are built into the
 * Rice Lake 1280 HMI runtime. The extractor needs that list to tell a runtime
 * call (`DisplayStatus`, `IntegerToString`) from a project-defined one
 * (`procBatchHandler`) — a call edge to a runtime function would dangle
 * forever, and a missing one would hide the real project call.
 *
 * Hand-typing ~450 names invites typos that silently drop call edges, so the
 * list is generated instead. Re-run after updating the grammar:
 *
 *   node scripts/gen-irite-vocabulary.mjs <path-to-irite.tmLanguage>
 *
 * The generated file is committed; this script only exists to regenerate it.
 */
import * as fs from 'fs';
import * as path from 'path';

const grammarPath = process.argv[2];
if (!grammarPath) {
  console.error('usage: node scripts/gen-irite-vocabulary.mjs <irite.tmLanguage>');
  process.exit(1);
}

// The grammar's XML declaration claims `encoding="UTF-16"`, but the bytes on
// disk are UTF-8 — reading it as UTF-16 yields mojibake. Trust the bytes.
const doc = fs.readFileSync(grammarPath, 'utf-8').replace(/^﻿/, '');

/** Pull the `<string>` body of every `<key>match</key>` + `<string>` pair. */
function matchStrings() {
  const out = [];
  const re = /<key>match<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(doc)) !== null) out.push(m[1]);
  return out;
}

const matches = matchStrings();

/** The alternation body of a `\b(?i:(...))\b` pattern, without the wrapper. */
function alternation(pattern) {
  const m = /^\s*\\b\(\?i:\(([\s\S]*)\)\)\\b\s*$/.exec(pattern);
  if (!m) return null;
  return m[1];
}

/**
 * Split an alternation body on top-level `|`, then keep only plain
 * identifiers. The grammar's lists contain regex fragments mixed in
 * (`\.Add`, `\(none`, `\$`) — those are not identifiers and are dropped.
 * `$`-suffixed Pascal-style names (`Chr$`, `Date$`) ARE identifiers, so the
 * regex escapes are unescaped BEFORE the shape test.
 */
function identifiers(body) {
  const names = new Set();
  for (const alt of body.split('|')) {
    // Unescape the grammar's regex escapes: `\$` → `$`, `\.` → `.`, `\(` → `(`.
    const name = alt.trim().replace(/\\(.)/g, '$1');
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*\$?$/.test(name)) continue;
    names.add(name);
  }
  return names;
}

// The two big lists are the ones with hundreds of entries; the pattern above
// cannot tell them apart by shape alone, so pick them by the scope they feed.
/**
 * Collect the identifiers of every `<dict>` whose scope name matches.
 *
 * Splitting on `<dict>` matters: a single regex over the whole document can
 * start at one `<key>match</key>` and span forward across several `<dict>`
 * boundaries to reach the wanted scope, which silently captures the WRONG
 * list. One dict = one rule.
 */
function listForScope(scope) {
  const names = new Set();
  for (const block of doc.split('<dict>')) {
    if (!block.includes(`<string>${scope}</string>`)) continue;
    const m = /<key>match<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(block);
    if (!m) continue;
    const body = alternation(m[1]);
    if (!body) continue;
    for (const id of identifiers(body)) names.add(id);
  }
  return names;
}

/**
 * The DataArray member methods, which the grammar lists DOTTED
 * (`\.Add`, `\.FindFirst`, …) inside the function scope. A dotted entry is
 * not a plain identifier, so it is collected separately: the extractor sees
 * `myArray.Add(x)` as a call to `Add` and must know it is runtime, not
 * project code.
 */
function listForDottedMethods(scope) {
  const names = new Set();
  for (const block of doc.split('<dict>')) {
    if (!block.includes(`<string>${scope}</string>`)) continue;
    const m = /<key>match<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(block);
    if (!m) continue;
    const body = alternation(m[1]);
    if (!body) continue;
    for (const alt of body.split('|')) {
      const name = alt.trim().replace(/\\(.)/g, '$1');
      if (!/^\.[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      names.add(name.slice(1));
    }
  }
  return names;
}

const fnList = listForScope('variable.parameter.irite');
const typeList = listForScope('storage.type.irite');
const methodList = listForDottedMethods('variable.parameter.irite');

/** Every identifier the runtime provides — the union of both grammar lists. */
const runtimeList = new Set([...fnList, ...typeList]);

/** Reserved words — never a call target, never a user symbol. */
const KEYWORDS = new Set(
  [
    'and', 'array', 'attribute', 'begin', 'case', 'constant', 'database', 'do', 'downto',
    'else', 'elsif', 'end', 'exit', 'external', 'for', 'forward', 'function', 'handler',
    'if', 'in', 'is', 'log', 'mod', 'not', 'of', 'or', 'program', 'procedure', 'record',
    'repeat', 'then', 'to', 'type', 'until', 'var', 'while', 'with', 'xor',
    // operator words the grammar lists under `keyword.operator.irite`
    'abs', 'asc', 'atan', 'bitand', 'bitor', 'bitxor', 'ceil', 'cos', 'exp', 'log10',
    'sin', 'sqrt', 'tan',
  ]
);

function sorted(list) {
  return [...list].sort((a, b) => a.localeCompare(b, 'en'));
}

const header = `/**
 * iRite vocabulary — the Rice Lake 1280 HMI runtime surface.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *
 *   node scripts/gen-irite-vocabulary.mjs <path-to-irite.tmLanguage>
 *
 * Source of truth: \`vscode-language-iRite/syntaxes/irite.tmLanguage\`
 * (the iRite TextMate grammar), which enumerates the runtime functions, the
 * built-in types/enums/constants, and the reserved words.
 *
 * The extractor uses these three sets to tell a RUNTIME call from a
 * PROJECT-DEFINED one. A call edge is only emitted for a name that is NOT a
 * runtime builtin: \`DisplayStatus(\"x\")\` is the HMI runtime talking to the
 * display, while \`procBatchHandler(...)\` is project code and deserves a
 * \`calls\` edge.
 */

/** Runtime functions and procedures provided by the 1280 HMI (Pascal-style \`$\` suffix included). */
export const IRITE_BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
`;

const mid = `]);

/**
 * Built-in types, enum members, constants and key identifiers provided by the
 * runtime. Used to decide whether a declared type is a runtime type (no
 * \`type_of\` edge — nothing to resolve) or a project type (an edge to the
 * record/enum that declares it).
 */
export const IRITE_BUILTIN_TYPES: ReadonlySet<string> = new Set([
`;

const tail = `]);

/**
 * DataArray member methods (\`arr.Add(x)\`, \`arr.FindFirst()\`, …). The
 * grammar lists them dotted; the extractor sees the bare member name.
 */
export const IRITE_BUILTIN_METHODS: ReadonlySet<string> = new Set([
${sorted(methodList).map((n) => `  '${n}',`).join('\n')}
]);

/**
 * Every identifier the 1280 HMI runtime provides — the union of the function
 * list and the type/constant list. A call whose name is in this set is
 * runtime traffic (no edge to resolve); anything else is project code.
 */
export const IRITE_RUNTIME_SYMBOLS: ReadonlySet<string> = new Set([
${sorted(runtimeList).map((n) => `  '${n}',`).join('\n')}
]);

/** Reserved words — never call targets, never project symbols. */
export const IRITE_KEYWORDS: ReadonlySet<string> = new Set([
${sorted(KEYWORDS).map((k) => `  '${k}',`).join('\n')}
]);
`;

const out =
  header +
  sorted(fnList).map((n) => `  '${n}',`).join('\n') +
  '\n' +
  mid +
  sorted(typeList).map((n) => `  '${n}',`).join('\n') +
  '\n' +
  tail;

const outPath = path.join(process.cwd(), 'src', 'extraction', 'languages', 'irite-vocabulary.ts');
fs.writeFileSync(outPath, out, 'utf-8');
console.log(`wrote ${outPath}`);
console.log(`  functions: ${fnList.size}`);
console.log(`  types/constants: ${typeList.size}`);
console.log(`  methods: ${methodList.size}`);
console.log(`  runtime symbols (union): ${runtimeList.size}`);
console.log(`  keywords: ${KEYWORDS.size}`);
