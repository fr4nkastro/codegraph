# iRite — the Rice Lake 1280 HMI dialect

iRite is the proprietary Pascal-like dialect of the **Revolution iRite Editor**,
the toolchain that programs the Rice Lake 1280 weighing indicator. Unlike the
languages that ride on tree-sitter, iRite has **no grammar**: the vendor ships
none, the syntax is closed, and no public grammar exists. So iRite is handled
by a custom extractor — `src/extraction/languages/irite.ts` — that parses the
source with a line-oriented scanner, the same approach `dfm-extractor.ts` takes
for Delphi form files.

| | |
|---|---|
| Language id | `irite` |
| Extensions | `.iri` (a module), `.src` (the program unit) |
| Extractor | `src/extraction/languages/irite.ts` |
| Vocabulary | `src/extraction/languages/irite-vocabulary.ts` (generated) |
| Tests | `__tests__/irite-extraction.test.ts` |

`.cod` is deliberately **not** mapped: it is the iRite editor's *compiled*
output — a binary blob (`IV=2.10,1280,D,20241129…`), not source. Indexing it
would only add noise.

## What the dialect looks like

A 1280 project is a program unit (`.src`) that includes modules (`.iri`):

```pascal
program main;

    #include generics\types.iri
    #include generics\strings.iri

    procedure procStartSystem;
    begin
        DisplayStatus("");
    end;

    function procCountCharsInt(iNumber: integer): integer;
        sysError: SysCode;          -- locals precede `begin`
    begin
        return Len(IntegerToString(iNumber,0));
    end;

    handler UserPrompt;              -- an HMI event handler
        sEntry: string;
    begin
        sEntry:= GetEntry;
    end;

    begin                            -- the program unit's startup block
        procStartSystem();
    end main;
```

and the modules declare the types:

```pascal
type Account is
record
    Id : Integer;
    Name : String;
end record;

type BatchState is (               -- an enumeration
    StateStart,
    StateIdle
);

type arrItems is array[10] of Item; -- an array type
type ItemsDatabase is database ("Items");
```

## What gets extracted

| iRite construct | CodeGraph node |
|---|---|
| `program main; … end main;` | `module` |
| `procedure X(…)` / `function X(…): T` / `handler X` | `function` |
| parameter list | `parameter` (one per parameter, with its type) |
| locals between the header and `begin` | `variable` |
| `type X is record … end record;` | `struct` (+ `field` per member) |
| `type X is (a, b, c);` | `enum` (+ `enum_member` per value) |
| `type X is array[…] of T;` / `is database (…)` | `type_alias` |
| `g_cEmpty: constant integer:= -1;` | `constant` |
| `g_dbItems: ItemsDatabase;` | `variable` |
| `#include path\to\file.iri` | `imports` edge to the included file |
| `procOther(…)` | `calls` edge to the routine |
| `x: ProjectType;` | `type_of` edge to the type declaration |

## Runtime vs project code — the one rule that matters

The 1280 runtime provides roughly 700 functions, types and constants
(`DisplayStatus`, `IntegerToString`, `GetGross`, `SysCode`, `ModeEnum`, …).
A call to one of those has nothing to resolve against, and an edge to it would
dangle forever. A call to a **project** routine (`procBatchHandler`) is exactly
the link an agent needs to follow.

So the extractor only emits a `calls` edge when the callee is **not** part of
the runtime surface. That surface comes from the iRite TextMate grammar
(`vscode-language-iRite/syntaxes/irite.tmLanguage`), which enumerates it — the
same grammar that drives the VS Code syntax highlighting.

The vocabulary is **generated**, not hand-typed, because ~700 hand-copied
names invite typos that silently drop call edges:

```bash
node scripts/gen-irite-vocabulary.mjs <path-to-irite.tmLanguage>
```

That rewrites `src/extraction/languages/irite-vocabulary.ts` from the grammar.
Re-run it after updating the grammar.

## iRite is case-insensitive

`DBColumnReal` (runtime) and `DbColumnReal` (a call site) are the same
function. Two consequences, both handled:

- The vocabulary lookups are lowercased, so a runtime call spelled differently
  is still recognised as runtime and does not produce a bogus `calls` edge.
- iRite joins Pascal in `CASE_INSENSITIVE_LANGUAGES`, so a declaration
  `SetLabelKA` and a call site `SetLabelKa` still resolve to each other.

## `.src` is a generic extension

`.iri` exists only for iRite modules, but `.src` is used by unrelated tools —
the Erlang OTP resource file `<app>.app.src` has it too. Upstream deliberately
kept `.src` out of the extension map for exactly that reason ("far too generic
for the extension map"), and iRite does not change that: **the content
decides**.

A `.src` file that carries none of the dialect's markers — no routine, no
program unit, no `#include`, no `type … is`, no `constant` declaration and no
typed global — is not an iRite program unit. It is never indexed, the same way
a `.ts` that is really an MPEG transport stream is never indexed: the scanner
recognises it from its content at read time and drops it
(`isIriteSource` in `src/extraction/grammars.ts`).

`detectLanguage` follows the same rule: a `.src` whose content is not iRite
reports `unknown`, not `irite`.

## Known limitations

- The extractor is a scanner, not a parser: it reads the dialect's shapes but
  does not build a syntax tree, so it cannot evaluate expressions or track
  types beyond what is written in the declaration.
- `forward` / `external` / `attribute` prototypes are recognised as
  declarations without a body, but the body is not matched to them.
- `elsif` chains, `for … to …` loops and `loop … end loop;` are handled as
  part of the enclosing routine body, not as separate nodes.
- Doc comments (`-- @brief`, `-- @param`, `-- @return`) are attached to the
  declaration that follows them when they use those tags.
