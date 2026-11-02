/**
 * iRite extractor — the Rice Lake Revolution iRite dialect (1280 HMI).
 *
 * iRite is a proprietary Pascal-like dialect used by the Revolution iRite
 * Editor to program the Rice Lake 1280 weighing indicator. No tree-sitter
 * grammar exists for it (the vendor ships none and the syntax is closed), so
 * this extractor parses the source with a line-oriented scanner, the same
 * approach `dfm-extractor.ts` takes for Delphi form files.
 *
 * The dialect, as it appears in real 1280 projects:
 *
 *   program main;                      -- the program unit (only in `.src`)
 *       #include generics\types.iri    -- module include, order matters
 *       procedure procStartScreenMain;  -- a routine
 *       begin
 *           DisplayStatus("");          -- runtime call
 *           procBatchHandler(...);      -- project call
 *       end;
 *   end main;
 *
 *   function procCountCharsInt(iNumber: integer): integer;
 *       sysError: SysCode;              -- locals precede `begin`
 *   begin
 *       return Len(IntegerToString(iNumber,0));
 *   end;
 *
 *   handler WidgetClicked;              -- an HMI event handler
 *   begin
 *   end;
 *
 *   type Item is record              -- a record type
 *       Id : Integer;
 *   end record;
 *
 *   type Batch is (                    -- an enumerated type
 *       BatchStart,
 *       BatchIdle
 *   );
 *
 *   type arrItems is array[10] of Item; -- an array type
 *   type ItemsDatabase is database ("Items");
 *
 *   g_cEmpty: constant integer:= -1;    -- a global constant
 *
 * Extracted information:
 * - the program unit as NodeKind `module`
 * - routines (procedure / function / handler) as NodeKind `function`
 * - parameters and local variables as NodeKind `parameter` / `variable`
 * - record types as `struct`, enumerated types as `enum` with `enum_member`
 * - array / database / alias types as `type_alias`
 * - global constants as `constant`, global variables as `variable`
 * - `#include` directives as UnresolvedReference → EdgeKind `imports`
 * - project calls as UnresolvedReference → EdgeKind `calls`
 * - project-typed declarations as UnresolvedReference → EdgeKind `type_of`
 *
 * The runtime surface (the ~700 functions, types and constants the 1280
 * provides) comes from the iRite TextMate grammar — see `irite-vocabulary.ts`.
 * It is what separates a runtime call (`DisplayStatus`) from a project call
 * (`procBatchHandler`): only the latter deserves a `calls` edge.
 */

import {
  Node,
  Edge,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../../types';
import { generateNodeId } from '../tree-sitter-helpers';
import {
  IRITE_BUILTIN_METHODS,
  IRITE_BUILTIN_TYPES,
  IRITE_KEYWORDS,
  IRITE_RUNTIME_SYMBOLS,
} from './irite-vocabulary';

/**
 * iRite is CASE-INSENSITIVE — the runtime spells `DBColumnReal`, and a call
 * site may write `DbColumnReal`. Every vocabulary lookup is therefore done
 * against a lowercased copy of the sets, or a runtime call would be read as a
 * project call and leave an edge that can never resolve.
 */
const RUNTIME_SYMBOLS_LOWER = new Set(
  [...IRITE_RUNTIME_SYMBOLS].map((name) => name.toLowerCase())
);
const BUILTIN_TYPES_LOWER = new Set(
  [...IRITE_BUILTIN_TYPES].map((name) => name.toLowerCase())
);
const BUILTIN_METHODS_LOWER = new Set(
  [...IRITE_BUILTIN_METHODS].map((name) => name.toLowerCase())
);

/** A named declaration with an optional type: a parameter, a local, a field. */
interface Declaration {
  name: string;
  type?: string;
  isConst: boolean;
}

/** A routine (procedure / function / handler) and the region of its body. */
interface Routine {
  kind: 'procedure' | 'function' | 'handler';
  name: string;
  params: Declaration[];
  returnType?: string;
  /** Offset of the `procedure` / `function` / `handler` keyword. */
  headerStart: number;
  /** Offset just past the header's terminating `;`. */
  headerEnd: number;
  /** Offset of the `begin` that opens the body, or -1 for a prototype. */
  bodyStart: number;
  /** Offset just past the body's closing `end`. */
  bodyEnd: number;
  /** 1-based line of the header. */
  line: number;
  /** True for a `forward` / `external` / `attribute` declaration (no body). */
  prototype: boolean;
  /** Node id, assigned when the routine is emitted. */
  id: string;
  /** The program node the routine belongs to, when declared inside one. */
  programId?: string;
}

/**
 * Blank out comments and string literals, preserving every character position
 * so an offset into the masked text maps 1:1 back to the original source
 * (and therefore to a line and column). Regexes over the masked text can then
 * never match inside a comment or a string literal.
 *
 * iRite comments are `--` to end of line and `(* … *)` blocks; strings are
 * double-quoted (with backslash escapes) or single-quoted (with `''` as the
 * escaped apostrophe).
 */
export function maskSource(source: string): string {
  const out = source.split('');
  const n = source.length;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < n) {
    const ch = source[i]!;

    // Line comment: `--` to end of line.
    if (ch === '-' && source[i + 1] === '-') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment: `(* … *)`.
    if (ch === '(' && source[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === ')')) j++;
      const end = Math.min(j + 2, n);
      blank(i, end);
      i = end;
      continue;
    }

    // String literal: "…" (backslash escapes) or '…' (doubled apostrophe).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          if (quote === "'" && source[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const end = Math.min(j + 1, n);
      blank(i, end);
      i = end;
      continue;
    }

    i++;
  }

  return out.join('');
}

/**
 * Parse a declaration list — the text between a routine header and its
 * `begin`, a parameter list, or a record body.
 *
 * Recognised shapes:
 *   `name: Type`              — a variable or parameter
 *   `name: constant Type`     — a constant
 *   `name: constant Type:= 1` — a constant with an initialiser
 *   `a, b: Type`              — grouped names (Pascal allows this)
 */
export function parseIriteDeclarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  // A declaration runs up to its `;` (or `,` for grouped names); the type is
  // the identifier that follows the colon.
  const re = /([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*(?:constant\s+)?([A-Za-z_][\w.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const isConst = /\bconstant\b/i.test(m[0]);
    const type = m[2]!;
    for (const rawName of m[1]!.split(',')) {
      const name = rawName.trim();
      if (!name) continue;
      out.push({ name, type, isConst });
    }
  }
  return out;
}

/**
 * Split a parameter list into declarations. iRite separates parameters with
 * `;` (not `,`), and may prefix one with `var` for a by-reference parameter.
 */
function parseParameterList(paramText: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of paramText.split(';')) {
    const chunk = part.trim();
    if (!chunk) continue;
    // `var name: Type` — the `var` is a by-reference marker, not part of the name.
    const withoutVar = chunk.replace(/^var\s+/i, '');
    const colon = withoutVar.indexOf(':');
    if (colon < 0) continue;
    const names = withoutVar.slice(0, colon);
    const type = withoutVar.slice(colon + 1).trim();
    const typeName = /^[A-Za-z_][\w.]*$/.exec(type)?.[0];
    if (!typeName) continue;
    for (const rawName of names.split(',')) {
      const name = rawName.trim();
      if (!name) continue;
      out.push({ name, type: typeName, isConst: false });
    }
  }
  return out;
}

/** Offsets of the start of every line, for offset → line/column conversion. */
function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * Find the offset of the `end` that closes a `begin` block starting at
 * `bodyStart`.
 *
 * The block depth counts `begin` / `end` pairs. `end if;`, `end loop;` and
 * `end record;` close their own construct — they are NOT the `end` of a
 * `begin` block — so they are skipped. Returns -1 when the block is
 * unterminated.
 */
function findBlockEnd(masked: string, bodyStart: number): number {
  const re = /\b(begin|end)\b/gi;
  re.lastIndex = bodyStart;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const word = m[1]!.toLowerCase();
    if (word === 'begin') {
      depth++;
      continue;
    }
    // `end if` / `end loop` / `end case` / `end record` close a different block.
    const after = masked.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (/^\s+(if|loop|case|record)\b/i.test(after)) continue;
    depth--;
    if (depth === 0) return m.index;
  }
  return -1;
}

/**
 * Whether a source carries any iRite marker at all.
 *
 * `.iri` is unambiguous — the extension exists only for iRite modules. `.src`
 * is a GENERIC extension (other projects use it for unrelated text), so a
 * `.src` file with no iRite marker is not an iRite program unit.
 *
 * The markers are the constructs only iRite has: a routine, a program unit,
 * an `#include`, a `type … is` declaration, the `constant` declaration
 * modifier, or a line-anchored typed global (`g_cEmpty: constant integer:= -1;`).
 *
 * The source is masked first, so a marker inside a comment or a string does
 * not count — the same rule the extractor itself reads by.
 */
export function looksLikeIrite(source: string): boolean {
  const masked = maskSource(source);
  const strong = [
    /\b(?:procedure|function|handler)\s+[A-Za-z_]\w*/,
    /\bprogram\s+[A-Za-z_]\w*\s*;/,
    /^[ \t]*#include\b/m,
    /\btype\s+[A-Za-z_]\w*\s+is\b/,
    /:\s*constant\b/,
    // A line-anchored typed global — `g_dbItems: ItemsDatabase;`
    /^[ \t]*[A-Za-z_]\w*\s*:\s*[A-Za-z_]\w*\s*(?:;|:=|,)/m,
  ];
  return strong.some((re) => re.test(masked));
}

/**
 * iRite extractor.
 *
 * Parses one `.iri` / `.src` source file into CodeGraph nodes, edges and
 * unresolved references.
 */
export class IriteExtractor {
  private filePath: string;
  private source: string;
  /** Source with comments and strings blanked — same length as `source`. */
  private masked = '';
  private lineStarts: number[] = [0];
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /** Extract the iRite symbols from the source. */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      this.masked = maskSource(this.source);
      this.lineStarts = computeLineStarts(this.source);

      const fileNode = this.createFileNode();

      // `.iri` is unambiguous; `.src` is a generic extension, so a file that
      // carries no iRite marker is not an iRite program unit. The scanner
      // already refuses to index such a file (see `isIriteProgramUnit`); the
      // guard here covers a file reached by another path.
      const isAmbiguousExtension = this.filePath.toLowerCase().endsWith('.src');
      if (isAmbiguousExtension && !looksLikeIrite(this.source)) {
        return {
          nodes: this.nodes,
          edges: this.edges,
          unresolvedReferences: this.unresolvedReferences,
          errors: this.errors,
          durationMs: Date.now() - startTime,
        };
      }

      this.parseIncludes(fileNode);
      const program = this.parseProgram(fileNode);
      const routines = this.parseRoutines(fileNode, program);
      this.parseTypes(fileNode, program);
      this.parseGlobals(fileNode, program, routines);
      this.parseCalls(routines);
    } catch (error) {
      this.errors.push({
        message: `iRite extraction error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  // -------------------------------------------------------------------------
  // Position helpers
  // -------------------------------------------------------------------------

  /** 1-based line number of an offset in the original source. */
  private lineAt(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** 0-based column of an offset in the original source. */
  private columnAt(offset: number): number {
    return offset - this.lineStarts[this.lineAt(offset) - 1]!;
  }

  /** The original (unmasked) text of a region. */
  private textOf(start: number, end: number): string {
    return this.source.slice(start, end);
  }

  /**
   * The line a declaration's name sits on, within a region.
   *
   * A routine's parameters and locals all live on the header's line, so
   * taking the routine's line for each of them would give them all the same
   * position — and node ids are hashed from the name and the line, so two
   * same-named declarations could collide. Finding the name's own line fixes
   * both the position the viewer jumps to and the id.
   */
  private declarationLine(regionStart: number, regionEnd: number, name: string, fallback: number): number {
    const region = this.masked.slice(regionStart, regionEnd);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`\\b${escaped}\\s*:`, 'i').exec(region);
    return m ? this.lineAt(regionStart + m.index) : fallback;
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  /** Create the file node every symbol hangs off. */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath.split('/').pop() || this.filePath,
      filePath: this.filePath,
      language: 'irite',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  /** Register a node and its containment edge. */
  private addNode(
    kind: Node['kind'],
    name: string,
    qualifiedName: string,
    parentId: string,
    startLine: number,
    endLine: number,
    startColumn: number,
    endColumn: number,
    extra: Partial<Node> = {}
  ): Node {
    const id = generateNodeId(this.filePath, kind, name, startLine);
    const node: Node = {
      id,
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'irite',
      startLine,
      endLine,
      startColumn,
      endColumn,
      updatedAt: Date.now(),
      ...extra,
    };
    this.nodes.push(node);
    this.edges.push({ source: parentId, target: id, kind: 'contains' });
    return node;
  }

  /** Record an unresolved reference (a candidate edge the resolver may close). */
  private addReference(
    fromNodeId: string,
    referenceName: string,
    referenceKind: UnresolvedReference['referenceKind'],
    line: number,
    column: number
  ): void {
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind,
      line,
      column,
      filePath: this.filePath,
      language: 'irite',
    });
  }

  // -------------------------------------------------------------------------
  // Includes
  // -------------------------------------------------------------------------

  /**
   * `#include <path>` pulls another iRite module into the program unit. The
   * include order matters (the editor compiles the unit as one program), so
   * the include is emitted as an `imports` reference from the file.
   *
   * The paths use Windows separators (`generics\types.iri`); they are
   * normalized to forward slashes so the resolver can match them against
   * project-relative file paths.
   */
  private parseIncludes(fileNode: Node): void {
    const re = /^[ \t]*#include[ \t]+([^\r\n]+?)[ \t]*$/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.masked)) !== null) {
      const raw = m[1]!.trim();
      if (!raw) continue;
      const normalized = raw.replace(/\\/g, '/');
      this.addReference(fileNode.id, normalized, 'imports', this.lineAt(m.index), this.columnAt(m.index));
    }
  }

  // -------------------------------------------------------------------------
  // Program unit
  // -------------------------------------------------------------------------

  /**
   * The `program <name>; … end <name>;` unit. Only `.src` files have one —
   * `.iri` files are modules that are pulled in by a program unit.
   *
   * Returns the node id of the program, or undefined when the file has none.
   */
  private parseProgram(fileNode: Node): string | undefined {
    const re = /\bprogram\s+([A-Za-z_]\w*)\s*;/gi;
    const m = re.exec(this.masked);
    if (!m) return undefined;

    const name = m[1]!;
    const headerEnd = m.index + m[0].length;
    const startLine = this.lineAt(m.index);

    // The unit closes with `end <name>;`.
    const endRe = new RegExp(`\\bend\\s+${name}\\s*;`, 'i');
    const endMatch = endRe.exec(this.masked.slice(headerEnd));
    const endOffset = endMatch ? headerEnd + endMatch.index : this.masked.length;
    const endLine = this.lineAt(Math.min(endOffset, this.masked.length - 1));

    const program = this.addNode(
      'module',
      name,
      name,
      fileNode.id,
      startLine,
      endLine,
      this.columnAt(m.index),
      this.columnAt(Math.min(endOffset, this.masked.length - 1)),
      { signature: `program ${name}` }
    );
    return program.id;
  }

  // -------------------------------------------------------------------------
  // Routines
  // -------------------------------------------------------------------------

  /**
   * Find every procedure, function and handler, with its parameters, its
   * local declarations and the region of its body.
   */
  private parseRoutines(fileNode: Node, programId?: string): Routine[] {
    const routines: Routine[] = [];

    // `procedure X(a: integer);` / `function X(a: integer): real;` /
    // `handler X;` — the parameter list may span lines, hence `[^()]*`.
    const re =
      /\b(procedure|function|handler)\s+([A-Za-z_]\w*)\s*(\(([^()]*)\))?\s*(?::\s*([A-Za-z_]\w*))?\s*;/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.masked)) !== null) {
      const kind = m[1]!.toLowerCase() as Routine['kind'];
      const name = m[2]!;
      const paramText = m[4];
      const returnType = m[5];
      const headerEnd = m.index + m[0].length;
      const line = this.lineAt(m.index);

      // A declaration followed by `forward` / `external` / `attribute` is a
      // prototype: it has no body of its own.
      const afterHeader = /^\s*(forward|external|attribute)\b/i.exec(
        this.masked.slice(headerEnd)
      );

      const routine: Routine = {
        kind,
        name,
        params: paramText ? parseParameterList(paramText) : [],
        returnType,
        headerStart: m.index,
        headerEnd,
        bodyStart: -1,
        bodyEnd: headerEnd,
        line,
        prototype: Boolean(afterHeader),
        id: '',
      };

      if (!routine.prototype) {
        // The body opens at the first `begin` after the header; the text in
        // between holds the local declarations.
        const beginRe = /\bbegin\b/gi;
        beginRe.lastIndex = headerEnd;
        const beginMatch = beginRe.exec(this.masked);
        if (beginMatch) {
          routine.bodyStart = beginMatch.index;
          const end = findBlockEnd(this.masked, beginMatch.index);
          routine.bodyEnd = end >= 0 ? end + 3 : this.masked.length;
        }
      }

      routines.push(routine);
    }

    for (const routine of routines) {
      const parentId = programId ?? fileNode.id;
      const endLine = this.lineAt(Math.min(routine.bodyEnd, this.masked.length - 1));

      const node = this.addNode(
        'function',
        routine.name,
        routine.name,
        parentId,
        routine.line,
        endLine,
        this.columnAt(routine.headerStart),
        this.columnAt(Math.min(routine.bodyEnd, this.masked.length - 1)),
        {
          signature: this.buildSignature(routine),
          returnType: routine.returnType,
          docstring: this.buildDocstring(routine.line),
        }
      );
      routine.id = node.id;
      routine.programId = programId;

      // Parameters.
      for (const param of routine.params) {
        const paramLine = this.declarationLine(
          routine.headerStart,
          routine.headerEnd,
          param.name,
          routine.line
        );
        this.addNode(
          'parameter',
          param.name,
          `${routine.name}::${param.name}`,
          routine.id,
          paramLine,
          paramLine,
          0,
          0,
          { signature: param.type, returnType: param.type }
        );
        if (param.type) this.addTypeReference(routine.id, param.type, paramLine);
      }

      // Local declarations — the text between the header and `begin`.
      if (routine.bodyStart >= 0) {
        const localsText = this.masked.slice(routine.headerEnd, routine.bodyStart);
        for (const local of parseIriteDeclarations(localsText)) {
          // A parameter is redeclared in some iRite sources; the parameter
          // node already exists, so the local is skipped.
          if (routine.params.some((p) => p.name.toLowerCase() === local.name.toLowerCase())) {
            continue;
          }
          const localLine = this.declarationLine(
            routine.headerEnd,
            routine.bodyStart,
            local.name,
            this.lineAt(routine.headerEnd)
          );
          this.addNode(
            local.isConst ? 'constant' : 'variable',
            local.name,
            `${routine.name}::${local.name}`,
            routine.id,
            localLine,
            localLine,
            0,
            0,
            { signature: local.type, returnType: local.type }
          );
          if (local.type) this.addTypeReference(routine.id, local.type, localLine);
        }
      }
    }

    return routines;
  }

  /** The human-readable signature of a routine. */
  private buildSignature(routine: Routine): string {
    const params = routine.params.map((p) => `${p.name}: ${p.type}`).join('; ');
    const head = `${routine.kind} ${routine.name}(${params})`;
    return routine.returnType ? `${head}: ${routine.returnType}` : head;
  }

  /**
   * The doc comment block that precedes a declaration, if any.
   *
   * iRite projects document routines with `--` comments; the conventional
   * tags are `@procedure`, `@brief`, `@param` and `@return`.
   */
  private buildDocstring(line: number): string | undefined {
    const lines = this.source.split('\n');
    const collected: string[] = [];
    for (let i = line - 2; i >= 0; i--) {
      const text = lines[i]!.trim();
      if (!text) {
        // A blank line ends the comment block.
        if (collected.length > 0) break;
        continue;
      }
      if (!text.startsWith('--')) break;
      collected.unshift(text.replace(/^--\s?/, ''));
      if (collected.length >= 20) break;
    }
    if (collected.length === 0) return undefined;
    const joined = collected.join('\n');
    return /@(procedure|brief|param|return)\b/i.test(joined) ? joined : undefined;
  }

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  /**
   * Parse the type declarations of a file:
   *   `type X is record … end record;`  → `struct` (+ `field` members)
   *   `type X is (a, b, c);`             → `enum` (+ `enum_member`s)
   *   `type X is array[N] of T;`         → `type_alias`
   *   `type X is database ("Name");`     → `type_alias`
   */
  private parseTypes(fileNode: Node, programId?: string): void {
    const re = /\btype\s+([A-Za-z_]\w*)\s+is\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.masked)) !== null) {
      const name = m[1]!;
      const startLine = this.lineAt(m.index);
      const parentId = programId ?? fileNode.id;
      const after = m.index + m[0].length;

      // The declaration runs from `is` to its own terminator: `end record`
      // for a record, the `;` for everything else. The boundary has to be
      // found FIRST — searching for a `(` or a `;` across the whole file
      // would run into the NEXT declaration and swallow it.
      const rest = this.masked.slice(after);
      const recordEnd = /\bend\s+record\b/i.exec(rest);

      // A record is identified by the keyword that follows `is`. Its
      // `end record` comes AFTER the fields' own semicolons, so the `;` is
      // no guide here.
      if (/^\s*record\b/i.test(rest)) {
        const bodyEnd = recordEnd ? after + recordEnd.index : this.masked.length;
        this.parseRecordType(name, m.index, after, bodyEnd, parentId, startLine);
        re.lastIndex = bodyEnd;
        continue;
      }

      const semi = rest.indexOf(';');
      const endOffset = semi < 0 ? this.masked.length : after + semi;
      const region = this.textOf(after, endOffset).trim();

      // An enumerated type: `type X is (a, b, c);`
      if (region.startsWith('(')) {
        const closeParen = region.lastIndexOf(')');
        const membersText = region.slice(1, closeParen < 0 ? region.length : closeParen);

        const enumNode = this.addNode(
          'enum',
          name,
          name,
          parentId,
          startLine,
          this.lineAt(Math.min(endOffset, this.masked.length - 1)),
          this.columnAt(m.index),
          this.columnAt(Math.min(endOffset, this.masked.length - 1)),
          { signature: `(${membersText.replace(/\s+/g, ' ').trim()})` }
        );

        // The members — comma separated, one per line in practice.
        const members = membersText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const member of members) {
          const memberName = /^[A-Za-z_]\w*/.exec(member)?.[0];
          if (!memberName) continue;
          const memberLine = this.declarationLine(after, endOffset, memberName, startLine);
          this.addNode(
            'enum_member',
            memberName,
            `${name}::${memberName}`,
            enumNode.id,
            memberLine,
            memberLine,
            0,
            0,
            { signature: member }
          );
        }
        re.lastIndex = endOffset;
        continue;
      }

      // Everything else is an alias: an array type, a database binding, or a
      // plain `type X is SomeType;`.
      this.addNode(
        'type_alias',
        name,
        name,
        parentId,
        startLine,
        this.lineAt(Math.min(endOffset, this.masked.length - 1)),
        this.columnAt(m.index),
        this.columnAt(Math.min(endOffset, this.masked.length - 1)),
        { signature: region.replace(/\s+/g, ' ').trim() }
      );
      re.lastIndex = endOffset;
    }
  }

  /** `type X is record … end record;` — a struct with `field` members. */
  private parseRecordType(
    name: string,
    declStart: number,
    bodyStart: number,
    bodyEnd: number,
    parentId: string,
    startLine: number
  ): void {
    const structNode = this.addNode(
      'struct',
      name,
      name,
      parentId,
      startLine,
      this.lineAt(Math.min(bodyEnd, this.masked.length - 1)),
      this.columnAt(declStart),
      this.columnAt(Math.min(bodyEnd, this.masked.length - 1)),
      { signature: `record` }
    );

    const body = this.masked.slice(bodyStart, bodyEnd);
    for (const field of parseIriteDeclarations(body)) {
      const fieldLine = this.declarationLine(bodyStart, bodyEnd, field.name, startLine);
      this.addNode(
        'field',
        field.name,
        `${name}::${field.name}`,
        structNode.id,
        fieldLine,
        fieldLine,
        0,
        0,
        { signature: field.type, returnType: field.type }
      );
      if (field.type) this.addTypeReference(structNode.id, field.type, fieldLine);
    }
  }

  // -------------------------------------------------------------------------
  // Globals
  // -------------------------------------------------------------------------

  /**
   * The global constants and variables of a module:
   *   `g_cEmpty: constant integer:= -1;`
   *   `g_dbItems: ItemsDatabase;`
   */
  private parseGlobals(fileNode: Node, programId?: string, routines: Routine[] = []): void {
    // Everything a routine declares is local, not global: the parameters sit
    // INSIDE the header, the locals BETWEEN the header and the `begin`, and
    // the body follows. The whole routine region is excluded, or every
    // parameter would also be emitted as a global variable.
    const localRanges = routines.map((r) =>
      r.bodyStart >= 0
        ? ([r.headerStart, r.bodyEnd] as const)
        : ([r.headerStart, r.headerEnd] as const)
    );

    const re = /([A-Za-z_]\w*)\s*:\s*(constant\s+)?([A-Za-z_][\w.]*)\s*(?::=[^;]*)?;/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.masked)) !== null) {
      if (localRanges.some(([from, to]) => m!.index >= from && m!.index < to)) continue;
      // A record field (`Id : Integer;`) is handled by the type parser.
      if (this.isInsideRecordField(m.index)) continue;

      const name = m[1]!;
      const isConst = Boolean(m[2]);
      const type = m[3]!;
      const line = this.lineAt(m.index);

      this.addNode(
        isConst ? 'constant' : 'variable',
        name,
        name,
        programId ?? fileNode.id,
        line,
        line,
        this.columnAt(m.index),
        this.columnAt(m.index + m[0].length),
        { signature: type, returnType: type }
      );
      if (type) this.addTypeReference(programId ?? fileNode.id, type, line);
    }
  }

  /**
   * Whether an offset falls inside a `record … end record` body.
   *
   * The LAST `record` keyword before the offset decides: a bare `record`
   * opens a record body, an `end record` closes it. Comparing raw substring
   * positions would be wrong — `end record` CONTAINS `record`, so the naive
   * "is the last `record` after the last `end record`" test says a global
   * declared after a record is still inside it, and drops the global.
   */
  private isInsideRecordField(offset: number): boolean {
    const before = this.masked.slice(0, offset);
    const re = /\b(end[ \t]+)?record\b/gi;
    let lastIsEnd: boolean | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(before)) !== null) {
      lastIsEnd = Boolean(m[1]);
    }
    return lastIsEnd === false;
  }

  // -------------------------------------------------------------------------
  // References
  // -------------------------------------------------------------------------

  /**
   * A declared type that is NOT part of the runtime surface is a project
   * type — the declaration points at the record / enum that defines it.
   */
  private addTypeReference(fromNodeId: string, type: string, line: number): void {
    if (BUILTIN_TYPES_LOWER.has(type.toLowerCase())) return;
    if (IRITE_KEYWORDS.has(type.toLowerCase())) return;
    this.addReference(fromNodeId, type, 'type_of', line, 0);
  }

  /**
   * The calls made inside each routine body.
   *
   * Only PROJECT calls get an edge: a name the 1280 runtime provides
   * (`DisplayStatus`, `IntegerToString`, `Len`) is runtime traffic and would
   * dangle forever, while a project routine (`procBatchHandler`) is exactly
   * the link an agent needs to follow.
   */
  private parseCalls(routines: Routine[]): void {
    const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
    for (const routine of routines) {
      if (routine.bodyStart < 0) continue;
      const body = this.masked.slice(routine.bodyStart, routine.bodyEnd);
      callRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(body)) !== null) {
        const callee = m[1]!;
        const calleeLower = callee.toLowerCase();
        const absolute = routine.bodyStart + m.index;

        // A member call (`arr.Add(x)`) — the member name is what matters.
        const before = this.masked.slice(Math.max(0, absolute - 40), absolute);
        const isMemberCall = /\.\s*$/.test(before);
        if (isMemberCall && BUILTIN_METHODS_LOWER.has(calleeLower)) continue;

        if (IRITE_KEYWORDS.has(calleeLower)) continue;
        if (RUNTIME_SYMBOLS_LOWER.has(calleeLower)) continue;
        if (BUILTIN_METHODS_LOWER.has(calleeLower)) continue;
        // A call to the routine itself (recursion) is not an edge worth making.
        if (calleeLower === routine.name.toLowerCase()) continue;

        this.addReference(routine.id, callee, 'calls', this.lineAt(absolute), this.columnAt(absolute));
      }
    }
  }
}
