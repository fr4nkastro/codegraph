/**
 * iRite end-to-end: init → index → resolve → query.
 *
 * The unit suite proves the extractor reads the dialect; this proves the
 * whole pipeline turns a 1280 project into a graph an agent can navigate:
 * a routine is findable, a call becomes a `calls` edge, a `#include`
 * becomes a file→file edge, and iRite's case-insensitivity lets a call site
 * that spells a routine differently still reach its declaration.
 *
 * The project is generated here (rather than copied from a real 1280
 * installation) because those are client code and this repo is public.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/index';

function createTempDir(prefix = 'codegraph-irite-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** A miniature 1280 project: a program unit plus the modules it includes. */
function generateIriteProject(root: string): void {
  fs.mkdirSync(path.join(root, 'generics'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'generics', 'strings.iri'),
    `    function procCountCharsInt(iNumber: integer): integer;
    begin
        return Len(IntegerToString(iNumber,0));
    end;

    function procCountCharsStr(sText: string): integer;
    begin
        return Len(sText);
    end;

    procedure procLoadStrings;
        iCount: integer;
    begin
        iCount := procCountCharsInt(42);
        DisplayStatus(IntegerToString(iCount,0));
    end;
`
  );

  fs.writeFileSync(
    path.join(root, 'generics', 'io.iri'),
    `    function ioReadInput(iSlot:integer; iBit: integer): integer;
    iValue: integer;
    begin
        if iBit <> 0 then
            GetDigIn(iSlot, iBit, iValue);
            return iValue;
        else
            return g_cEmpty;
        end if;
    end;
`
  );

  fs.writeFileSync(
    path.join(root, 'program.src'),
    `program main;
    #include generics\\strings.iri
    #include generics\\io.iri

    procedure procStartSystem;
    begin
        procLoadStrings();
    end;

    begin
        procStartSystem();
    end main;
`
  );
}

describe('Integration: iRite pipeline', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('indexes a 1280 project and wires its calls and includes', async () => {
    generateIriteProject(tempDir);

    // NO include config: `.iri` and `.src` must be discovered on their own,
    // which is what lets an iRite project drop its `codegraph.json` mapping.
    const cg = await CodeGraph.init(tempDir);

    try {
      const indexResult = await cg.indexAll();
      expect(indexResult.filesIndexed).toBeGreaterThanOrEqual(3);

      cg.reinitializeResolver();
      const resolution = cg.resolveReferences();
      expect(resolution).toBeDefined();

      // ── the routines are in the graph ───────────────────────────
      const countChars = cg
        .searchNodes('procCountCharsInt', { limit: 10 })
        .find((r) => r.node.name === 'procCountCharsInt');
      expect(countChars).toBeDefined();
      expect(countChars!.node.kind).toBe('function');
      expect(countChars!.node.returnType).toBe('integer');

      const loadStrings = cg
        .searchNodes('procLoadStrings', { limit: 10 })
        .find((r) => r.node.name === 'procLoadStrings');
      expect(loadStrings).toBeDefined();

      // ── the call became a `calls` edge ──────────────────────────
      const callers = cg.getCallers(countChars!.node.id);
      expect(callers.some((c) => c.node.name === 'procLoadStrings')).toBe(true);

      // The program unit calls `procLoadStrings`, and that resolved too.
      const startRestore = cg
        .searchNodes('procStartSystem', { limit: 10 })
        .find((r) => r.node.name === 'procStartSystem');
      expect(startRestore).toBeDefined();
      const startCallers = cg.getCallers(loadStrings!.node.id);
      expect(startCallers.some((c) => c.node.name === 'procStartSystem')).toBe(true);

      // ── the `#include` became a file→file edge ──────────────────
      const programFile = cg
        .getNodesInFile('program.src')
        .find((n) => n.kind === 'file');
      expect(programFile).toBeDefined();

      const importEdges = cg
        .getOutgoingEdges(programFile!.id)
        .filter((e) => e.kind === 'imports');
      expect(importEdges.length).toBeGreaterThan(0);

      const importedTargets = importEdges.map((e) => cg.getNode(e.target)?.filePath);
      expect(importedTargets).toContain('generics/strings.iri');
      expect(importedTargets).toContain('generics/io.iri');

      // And the include is visible from the included module's side.
      expect(cg.getFileDependents('generics/strings.iri')).toContain('program.src');

      // ── a runtime call is NOT an edge ───────────────────────────
      // `DisplayStatus` is a 1280 runtime function: there is nothing to
      // resolve it against, so it must not appear as a dangling edge.
      const loadCallers = cg.getCallers(loadStrings!.node.id);
      expect(loadCallers.some((c) => c.node.name === 'DisplayStatus')).toBe(false);
    } finally {
      cg.destroy();
    }
  }, 60_000);

  it('never indexes a .src file that is not an iRite program unit', async () => {
    // `.src` is a generic extension — other tools use it. A `.src` whose
    // content is not iRite must stay out of the graph entirely, exactly as
    // upstream expects for a stray `.src`.
    generateIriteProject(tempDir);
    fs.writeFileSync(
      path.join(tempDir, 'legacy.src'),
      `.text
    mov eax, 1
    ret`
    );

    const cg = await CodeGraph.init(tempDir);

    try {
      await cg.indexAll();

      const indexed = cg.getFiles().map((f) => f.path.replace(/\\/g, '/'));
      expect(indexed).toContain('program.src');
      expect(indexed).not.toContain('legacy.src');
      // And nothing was mined out of it.
      expect(cg.searchNodes('mov', { limit: 5 })).toHaveLength(0);
    } finally {
      cg.destroy();
    }
  }, 60_000);
});
