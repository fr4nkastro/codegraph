/**
 * iRite extraction — the Rice Lake Revolution iRite dialect (1280 HMI).
 *
 * iRite is a proprietary Pascal-like dialect with no tree-sitter grammar, so
 * `src/extraction/languages/irite.ts` parses it with a line-oriented scanner.
 * These tests cover two things:
 *
 *  1. The DIALECT — each construct the language has, asserted in isolation:
 *     routines, parameters, locals, records, enumerations, array and database
 *     types, module globals, `#include`, calls and type references.
 *
 *  2. The CORPUS — the fixture set under `__tests__/fixtures/irite/` is
 *     written in the dialect, and a live-corpus suite runs against the REAL
 *     1280 projects on the machine that has them (see `IRITE_CORPUS_ROOT`).
 *
 * The fixture files are written for this suite rather than copied from a
 * customer project: the 1280 projects are real client work, and this repo is
 * public. The live suite below is where the real files are asserted against.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { detectLanguage, isLanguageSupported } from '../src/extraction/grammars';
import { IriteExtractor, looksLikeIrite, maskSource } from '../src/extraction/languages/irite';
import type { Node, ExtractionResult } from '../src/types';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'irite');

function extract(filePath: string, source: string): ExtractionResult {
  return extractFromSource(filePath, source, 'irite');
}

function nodesOfKind(result: ExtractionResult, kind: Node['kind']): Node[] {
  return result.nodes.filter((n) => n.kind === kind);
}

function nodeNamed(result: ExtractionResult, name: string, kind?: Node['kind']): Node | undefined {
  return result.nodes.find((n) => n.name === name && (kind === undefined || n.kind === kind));
}

function callNames(result: ExtractionResult): string[] {
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === 'calls')
    .map((r) => r.referenceName);
}

function readFixture(relPath: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, relPath), 'utf-8');
}

describe('iRite extraction — dialect', () => {
  it('extracts a procedure with its parameters and its locals', () => {
    const result = extract(
      'demo.iri',
      `procedure procAddItem(iSource: integer; iItem: integer);
    iTotal: integer;
    iStatus: SysCode;
    begin
        iTotal := iSource + iItem;
        iStatus := SysOk;
    end;`
    );

    const proc = nodeNamed(result, 'procAddItem', 'function');
    expect(proc).toBeDefined();
    expect(proc!.kind).toBe('function');
    expect(proc!.signature).toBe('procedure procAddItem(iSource: integer; iItem: integer)');
    // A procedure has no return type.
    expect(proc!.returnType).toBeUndefined();

    const params = nodesOfKind(result, 'parameter');
    expect(params.map((p) => p.name)).toEqual(['iSource', 'iItem']);
    expect(params.map((p) => p.returnType)).toEqual(['integer', 'integer']);
    expect(params[0]!.qualifiedName).toBe('procAddItem::iSource');

    // The locals live between the header and the `begin`, and belong to the
    // routine — they are NOT module globals.
    const locals = nodesOfKind(result, 'variable');
    expect(locals.map((v) => v.name).sort()).toEqual(['iStatus', 'iTotal']);
    expect(locals[0]!.qualifiedName).toMatch(/^procAddItem::/);
    // `SysCode` is a runtime type; `integer` too — neither is a project type.
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'type_of')).toHaveLength(0);
  });

  it('extracts a function with its return type', () => {
    const result = extract(
      'demo.iri',
      `function procCountCharsInt(iNumber: integer): integer;
    begin
        return Len(IntegerToString(iNumber,0));
    end;`
    );

    const fn = nodeNamed(result, 'procCountCharsInt', 'function');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toBe('integer');
    expect(fn!.signature).toBe('function procCountCharsInt(iNumber: integer): integer');
    expect(nodeNamed(result, 'iNumber', 'parameter')!.returnType).toBe('integer');
  });

  it('extracts a handler', () => {
    const result = extract(
      'demo.iri',
      `handler UserPrompt;
    sEntry: string;
    begin
        sEntry:= GetEntry;
        ClosePrompt;
    end;`
    );

    const handler = nodeNamed(result, 'UserPrompt', 'function');
    expect(handler).toBeDefined();
    expect(handler!.signature).toBe('handler UserPrompt()');
    expect(nodeNamed(result, 'sEntry', 'variable')!.qualifiedName).toBe('UserPrompt::sEntry');
  });

  it('extracts a record type with its fields', () => {
    const result = extract(
      'demo.iri',
      `type Account is
record
    Id : Integer;
    Name : String;
end record;`
    );

    const record = nodeNamed(result, 'Account', 'struct');
    expect(record).toBeDefined();
    expect(record!.signature).toBe('record');

    const fields = nodesOfKind(result, 'field');
    expect(fields.map((f) => f.name)).toEqual(['Id', 'Name']);
    expect(fields.map((f) => f.returnType)).toEqual(['Integer', 'String']);
    expect(fields[0]!.qualifiedName).toBe('Account::Id');
  });

  it('extracts an enumerated type with its members', () => {
    const result = extract(
      'demo.iri',
      `type BatchState is (
    StateStart,
    StateIdle,
    StateDone
);`
    );

    const enumNode = nodeNamed(result, 'BatchState', 'enum');
    expect(enumNode).toBeDefined();
    expect(enumNode!.signature).toBe('(StateStart, StateIdle, StateDone)');

    const members = nodesOfKind(result, 'enum_member');
    expect(members.map((m) => m.name)).toEqual(['StateStart', 'StateIdle', 'StateDone']);
    expect(members[0]!.qualifiedName).toBe('BatchState::StateStart');
  });

  it('extracts array and database types as aliases', () => {
    const result = extract(
      'demo.iri',
      `type arrItems is array[10] of Item;
type ItemsDatabase is database ("Items");`
    );

    expect(nodeNamed(result, 'arrItems', 'type_alias')).toBeDefined();
    expect(nodeNamed(result, 'ItemsDatabase', 'type_alias')).toBeDefined();
    expect(nodeNamed(result, 'arrItems', 'type_alias')!.signature).toBe('array[10] of Item');
  });

  it('extracts a global declared AFTER a record type', () => {
    // `end record` CONTAINS the word `record`, so a naive "am I inside a
    // record body?" test says yes and drops every global that follows a
    // record declaration.
    const result = extract(
      'demo.iri',
      `type Account is
record
    Id : Integer;
end record;

g_dbItems: ItemsDatabase;
g_cEmpty: constant integer:= -1;`
    );

    expect(nodeNamed(result, 'Account', 'struct')).toBeDefined();
    expect(nodeNamed(result, 'g_dbItems', 'variable')).toBeDefined();
    expect(nodeNamed(result, 'g_cEmpty', 'constant')).toBeDefined();
    // The record's own field is a `field`, not a global variable.
    expect(nodeNamed(result, 'Id', 'variable')).toBeUndefined();
  });

  it('extracts module-level constants and variables', () => {
    const result = extract(
      'demo.iri',
      `    g_cEmpty: constant integer:= -1;
    g_dbItems: ItemsDatabase;
    g_sUserName: string;`
    );

    const constants = nodesOfKind(result, 'constant');
    expect(constants.map((c) => c.name)).toEqual(['g_cEmpty']);
    expect(constants[0]!.returnType).toBe('integer');

    const variables = nodesOfKind(result, 'variable');
    expect(variables.map((v) => v.name).sort()).toEqual(['g_dbItems', 'g_sUserName']);
    // `ItemsDatabase` is a PROJECT type — the variable points at it.
    const typeRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'type_of');
    expect(typeRefs.map((t) => t.referenceName)).toEqual(['ItemsDatabase']);
  });

  it('emits an import reference for #include', () => {
    const result = extract(
      'program.src',
      `program main;
    #include types\\records.iri
    #include generics\\io.iri
    begin
    end main;`
    );

    const imports = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    // The Windows separators are normalized so the path can be matched.
    expect(imports.map((i) => i.referenceName)).toEqual(['types/records.iri', 'generics/io.iri']);
  });

  it('emits the program unit as a module node', () => {
    const result = extract(
      'program.src',
      `program main;
    procedure procDoIt;
    begin
    end;
    begin
        procDoIt();
    end main;`
    );

    const program = nodeNamed(result, 'main', 'module');
    expect(program).toBeDefined();
    expect(program!.signature).toBe('program main');
    // The routine declared inside the unit belongs to the program.
    const routine = nodeNamed(result, 'procDoIt', 'function')!;
    const contains = result.edges.find((e) => e.kind === 'contains' && e.target === routine.id);
    expect(contains?.source).toBe(program!.id);
  });

  it('emits a call for a project routine but not for a runtime builtin', () => {
    const result = extract(
      'demo.iri',
      `procedure procRun;
    begin
        procOtherRoutine(1);
        DisplayStatus("hello");
        IntegerToString(5,0);
        Len("hello");
        procShowError(SysOk, "done");
    end;`
    );

    const calls = callNames(result);
    expect(calls).toContain('procOtherRoutine');
    expect(calls).toContain('procShowError');
    // Runtime functions of the 1280 — nothing to resolve them against.
    expect(calls).not.toContain('DisplayStatus');
    expect(calls).not.toContain('IntegerToString');
    expect(calls).not.toContain('Len');
  });

  it('matches runtime builtins regardless of case', () => {
    // iRite is case-insensitive: the runtime spells it `DBColumnReal`, a call
    // site may write `DbColumnReal`. Both are the runtime, not project code.
    const result = extract(
      'demo.iri',
      `procedure procRun;
    begin
        DbColumnReal("x");
        DBColumnReal("y");
    end;`
    );

    expect(callNames(result)).not.toContain('DbColumnReal');
    expect(callNames(result)).not.toContain('DBColumnReal');
  });

  it('does not treat a routine mentioned in a comment or a string as a symbol', () => {
    const result = extract(
      'demo.iri',
      `-- procedure procCommented;
procedure procReal;
    begin
        -- procInComment();
        DisplayStatus("procedure procInString;");
    end;`
    );

    expect(nodeNamed(result, 'procCommented')).toBeUndefined();
    expect(nodeNamed(result, 'procReal', 'function')).toBeDefined();
    expect(callNames(result)).not.toContain('procInComment');
    expect(callNames(result)).not.toContain('procInString');
  });

  it('ignores a .src file that holds no iRite at all', () => {
    // `.src` is a generic extension, so a file that carries none of the
    // dialect's markers is tracked as a plain file instead of being mined
    // for symbols that are not there.
    const result = extract(
      'notes.src',
      `.text
    mov eax, 1
    ret`
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.kind).toBe('file');
    expect(result.unresolvedReferences).toHaveLength(0);
  });

  it('recognises iRite markers', () => {
    expect(looksLikeIrite('procedure procX;\nbegin\nend;')).toBe(true);
    expect(looksLikeIrite('program main;\nbegin\nend main;')).toBe(true);
    expect(looksLikeIrite('g_cEmpty: constant integer:= -1;')).toBe(true);
    expect(looksLikeIrite('#include types\\records.iri')).toBe(true);
    expect(looksLikeIrite('.text\nmov eax, 1')).toBe(false);
    // A marker inside a comment is not a marker.
    expect(looksLikeIrite('-- procedure procX;\n-- program main;')).toBe(false);
  });

  it('leaves comments and strings blank without moving any offset', () => {
    const source = 'procedure procX;\n-- a comment\nbegin\n    DisplayStatus("text");\nend;';
    const masked = maskSource(source);
    expect(masked).toHaveLength(source.length);
    expect(masked).not.toContain('comment');
    expect(masked).not.toContain('text');
    // The code around them survives.
    expect(masked).toContain('procedure procX;');
    expect(masked).toContain('DisplayStatus');
  });

  it('parses a CRLF source the same as an LF one', () => {
    // Windows checkouts hand the extractor CRLF line endings.
    const lf = 'procedure procDoThing(iCount: integer);\n    iTotal: integer;\nbegin\n    iTotal := iCount;\nend;';
    const crlf = lf.replace(/\n/g, '\r\n');

    const fromLf = extract('demo.iri', lf);
    const fromCrlf = extract('demo.iri', crlf);

    expect(nodeNamed(fromCrlf, 'procDoThing', 'function')).toBeDefined();
    expect(nodeNamed(fromCrlf, 'procDoThing', 'function')!.signature).toBe(
      nodeNamed(fromLf, 'procDoThing', 'function')!.signature
    );
    expect(nodesOfKind(fromCrlf, 'variable').map((v) => v.name)).toEqual(
      nodesOfKind(fromLf, 'variable').map((v) => v.name)
    );
    // The `#include` path must not pick up the carriage return.
    const crlfImports = extract('program.src', 'program main;\r\n    #include types\\records.iri\r\nbegin\r\nend main;');
    expect(
      crlfImports.unresolvedReferences
        .filter((r) => r.referenceKind === 'imports')
        .map((r) => r.referenceName)
    ).toEqual(['types/records.iri']);
  });

  it('reports an empty result for an empty file', () => {
    const result = new IriteExtractor('empty.iri', '').extract();
    expect(result.errors).toHaveLength(0);
    expect(nodesOfKind(result, 'function')).toHaveLength(0);
  });
});

describe('iRite language registration', () => {
  it('recognizes the iRite extensions', () => {
    expect(detectLanguage('generics/types.iri')).toBe('irite');
    expect(detectLanguage('scale.src')).toBe('irite');
    expect(isLanguageSupported('irite')).toBe(true);
  });

  it('leaves an Erlang OTP .app.src file to the Erlang grammar', () => {
    // `.src` is the last-dot extension of an OTP resource file too. The
    // Erlang check runs before the extension map, so it still wins.
    expect(detectLanguage('myapp.app.src')).toBe('erlang');
  });

  it('decides a generic .src by its content', () => {
    // `.src` is a generic extension, so a file that carries none of the
    // dialect's markers is not an iRite program unit — and is never indexed.
    expect(detectLanguage('notes.src', 'nothing iRite in here')).toBe('unknown');
    expect(detectLanguage('scale.src', 'program main;\nbegin\nend main;')).toBe('irite');
  });

  it('still lets a project override the extension mapping', () => {
    // `codegraph.json` mappings win over the built-in map — that is how a
    // project re-points an extension.
    expect(detectLanguage('scale.src', undefined, { '.src': 'pascal' })).toBe('pascal');
  });
});

describe('iRite extraction — fixture corpus', () => {
  it('extracts the program unit and its includes', () => {
    const result = extract('program.src', readFixture('program.src'));

    expect(nodeNamed(result, 'main', 'module')).toBeDefined();
    const imports = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(imports.map((i) => i.referenceName)).toEqual([
      'types/records.iri',
      'types/enums.iri',
      'generics/globals.iri',
      'generics/strings.iri',
      'generics/io.iri',
      'handlers.iri',
    ]);
  });

  it('extracts the routines of the program unit', () => {
    const result = extract('program.src', readFixture('program.src'));

    const restore = nodeNamed(result, 'procStartSystem', 'function')!;
    expect(restore).toBeDefined();
    expect(restore.signature).toBe('procedure procStartSystem()');

    const scale = nodeNamed(result, 'procGetSourceNumber', 'function')!;
    expect(scale.returnType).toBe('integer');
    expect(nodeNamed(result, 'iSource', 'parameter')!.returnType).toBe('integer');
    expect(nodeNamed(result, 'iNumber', 'variable')!.qualifiedName).toBe('procGetSourceNumber::iNumber');
  });

  it('extracts the record types and their fields', () => {
    const result = extract('types/records.iri', readFixture('types/records.iri'));

    expect(nodeNamed(result, 'Account', 'struct')).toBeDefined();
    expect(nodeNamed(result, 'Item', 'struct')).toBeDefined();

    const userFields = nodesOfKind(result, 'field');
    expect(userFields.map((f) => f.name)).toEqual(['Id', 'Name', 'Secret', 'Code', 'Id', 'Name', 'Target', 'Counter', 'Created']);
    expect(userFields[0]!.qualifiedName).toBe('Account::Id');
    expect(userFields[4]!.qualifiedName).toBe('Item::Id');
  });

  it('extracts the enumerated, array and database types', () => {
    const result = extract('types/enums.iri', readFixture('types/enums.iri'));

    expect(nodeNamed(result, 'BatchState', 'enum')).toBeDefined();
    expect(nodesOfKind(result, 'enum_member').map((m) => m.name)).toEqual([
      'StateStart', 'StateIdle', 'StateDone', 'StateHalted',
      'strType', 'numType',
    ]);
    expect(nodeNamed(result, 'arrItems', 'type_alias')).toBeDefined();
    expect(nodeNamed(result, 'ItemsDatabase', 'type_alias')).toBeDefined();
  });

  it('extracts the module globals', () => {
    const result = extract('generics/globals.iri', readFixture('generics/globals.iri'));

    expect(nodesOfKind(result, 'constant').map((c) => c.name)).toEqual([
      'g_cEmpty', 'g_cMaxItems', 'g_bEnabled',
    ]);
    expect(nodesOfKind(result, 'variable').map((v) => v.name)).toEqual([
      'g_dbItems', 'g_sUserName',
    ]);
  });

  it('extracts the string helpers and their return types', () => {
    const result = extract('generics/strings.iri', readFixture('generics/strings.iri'));

    expect(nodeNamed(result, 'procCountCharsStr', 'function')!.returnType).toBe('integer');
    expect(nodeNamed(result, 'procCountCharsInt', 'function')!.returnType).toBe('integer');
    expect(nodeNamed(result, 'procCountCharsReal', 'function')!.returnType).toBe('integer');

    const real = nodeNamed(result, 'procCountCharsReal', 'function')!;
    const params = result.nodes.filter(
      (n) => n.kind === 'parameter' && n.qualifiedName.startsWith('procCountCharsReal::')
    );
    expect(params.map((p) => `${p.name}:${p.returnType}`)).toEqual([
      'rNumber:real', 'iDecimals:integer',
    ]);
    expect(real.signature).toBe(
      'function procCountCharsReal(rNumber: real; iDecimals: integer): integer'
    );
  });

  it('extracts the handlers with their elsif chain', () => {
    const result = extract('handlers.iri', readFixture('handlers.iri'));

    const handler = nodeNamed(result, 'UserPrompt', 'function')!;
    expect(handler).toBeDefined();
    expect(handler.signature).toBe('handler UserPrompt()');
    expect(nodeNamed(result, 'sEntry', 'variable')!.qualifiedName).toBe('UserPrompt::sEntry');
    expect(nodeNamed(result, 'WidgetClicked', 'function')).toBeDefined();

    // The `if / elsif / else / end if;` chain is one routine body — the
    // routine must not stop at the first `end if;`.
    const calls = callNames(result);
    expect(calls).toContain('procHandlerSettings');
    expect(calls).toContain('procHandlerMain');
    expect(calls).toContain('procHandlerUnknown');
    // `GetEntry` and `ClosePrompt` are runtime functions.
    expect(calls).not.toContain('GetEntry');
    expect(calls).not.toContain('ClosePrompt');
  });

  it('extracts the io helpers with their locals', () => {
    const result = extract('generics/io.iri', readFixture('generics/io.iri'));

    expect(nodeNamed(result, 'ioReadInput', 'function')!.returnType).toBe('integer');
    expect(nodeNamed(result, 'ioWriteOutput', 'function')!.returnType).toBe('SysCode');

    // The locals of each routine are distinct, and no local leaks out as a
    // module global.
    const variables = nodesOfKind(result, 'variable');
    expect(variables.map((v) => v.name).sort()).toEqual(['iValue', 'sysError']);
    expect(variables.every((v) => v.qualifiedName.includes('::'))).toBe(true);
  });
});

/**
 * The REAL 1280 projects.
 *
 * These are live client code, so nothing of them is committed to this repo —
 * the suite runs against them where they exist on disk and is skipped
 * elsewhere. Point `IRITE_CORPUS_ROOT` at a project root to enable it:
 *
 *   IRITE_CORPUS_ROOT="C:/Users/.../IPESAH/<project-root>" \
 *     npx vitest run __tests__/irite-extraction.test.ts
 */
const CORPUS_ROOT = process.env.IRITE_CORPUS_ROOT ?? '';
const corpusAvailable = CORPUS_ROOT !== '' && fs.existsSync(CORPUS_ROOT);

describe.skipIf(!corpusAvailable)('iRite extraction — live 1280 corpus', () => {
  /** Every iRite source file under the corpus root. */
  function corpusFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(iri|src)$/i.test(entry.name)) out.push(full);
      }
    };
    walk(CORPUS_ROOT);
    return out;
  }

  /** Extract the whole corpus; the aggregate is what the assertions read. */
  function extractCorpus(): { nodes: Node[]; errors: number } {
    const results = corpusFiles().map((file) =>
      extract(
        path.relative(CORPUS_ROOT, file).replace(/\\/g, '/'),
        fs.readFileSync(file, 'utf-8')
      )
    );
    return {
      nodes: results.flatMap((r) => r.nodes),
      errors: results.reduce((n, r) => n + r.errors.length, 0),
    };
  }

  // These assertions are STRUCTURAL on purpose: the live projects are real
  // client code, so the suite checks the SHAPE the extractor produces rather
  // than the project's own symbol names or file paths. Nothing of the
  // project is committed to this repo, and the suite works against any 1280
  // project rather than one layout.

  it('extracts every real file with no errors', () => {
    const corpus = extractCorpus();
    expect(corpus.nodes.length).toBeGreaterThan(0);
    expect(corpus.errors).toBe(0);
  });

  it('extracts real routines with typed signatures', () => {
    const corpus = extractCorpus();

    const functions = corpus.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThan(0);
    expect(functions.every((f) => f.signature !== undefined)).toBe(true);
    // A FUNCTION declares a return type; a PROCEDURE and a HANDLER do not.
    expect(
      functions.every(
        (f) =>
          f.signature!.startsWith('procedure ') ||
          f.signature!.startsWith('handler ') ||
          f.returnType !== undefined
      )
    ).toBe(true);
    // At least one routine returns an integer — the return types are real,
    // not defaulted.
    expect(functions.some((f) => f.returnType === 'integer')).toBe(true);

    // Parameters carry their type.
    const params = corpus.nodes.filter((n) => n.kind === 'parameter');
    expect(params.length).toBeGreaterThan(0);
    expect(params.every((p) => p.returnType !== undefined)).toBe(true);

    // A variable is either a file-level global (qualified by its own name) or
    // a routine local (qualified by `routine::name`). A local never leaks out
    // as a bare global.
    const variables = corpus.nodes.filter((n) => n.kind === 'variable');
    expect(variables.length).toBeGreaterThan(0);
    expect(
      variables.every((v) => v.qualifiedName === v.name || v.qualifiedName.includes('::'))
    ).toBe(true);
    expect(variables.some((v) => v.qualifiedName.includes('::'))).toBe(true);
  });

  it('extracts the real record and enumeration types', () => {
    const corpus = extractCorpus();

    const records = corpus.nodes.filter((n) => n.kind === 'struct');
    expect(records.length).toBeGreaterThan(0);
    const fields = corpus.nodes.filter((n) => n.kind === 'field');
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => f.returnType !== undefined)).toBe(true);
    expect(fields.every((f) => f.qualifiedName.includes('::'))).toBe(true);

    const members = corpus.nodes.filter((n) => n.kind === 'enum_member');
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => m.qualifiedName.includes('::'))).toBe(true);
  });

  it('extracts the real program unit and its includes', () => {
    const programFiles = corpusFiles().filter((f) => f.toLowerCase().endsWith('.src'));
    // A corpus pointed at a module folder has no program unit — the `.src`
    // lives at the project root, above it.
    if (programFiles.length === 0) return;
    expect(programFiles.length).toBeGreaterThan(0);

    const file = programFiles[0]!;
    const result = extract(
      path.relative(CORPUS_ROOT, file).replace(/\\/g, '/'),
      fs.readFileSync(file, 'utf-8')
    );

    expect(result.nodes.some((n) => n.kind === 'module')).toBe(true);
    const imports = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(imports.length).toBeGreaterThan(0);
    // The include paths are written with Windows separators; they are
    // normalized so the resolver can match them against project paths.
    expect(imports.every((i) => !i.referenceName.includes('\\'))).toBe(true);
    expect(imports.every((i) => i.referenceName.endsWith('.iri'))).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('extracts the routine the brief names, with its return type', () => {
    // `procCountCharsInt` returns an integer and takes an integer. It is
    // located by NAME across the corpus, so no file path from the project is
    // baked into this suite.
    const corpus = extractCorpus();
    const fn = corpus.nodes.find((n) => n.kind === 'function' && n.name === 'procCountCharsInt');
    if (!fn) return; // this corpus has no such routine
    expect(fn.returnType).toBe('integer');
    expect(fn.signature).toContain('iNumber: integer');
  });
});
