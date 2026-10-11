// What a failing test protects and how it failed, read without running anything more (PRD 0.4
// section 4.2): the test's docstring from its source at the tested commit, and the assertion line and
// first error line pytest printed for it. A merge plan states each break in these words, so an owner
// reads "Patrons who log in on one library tablet stay separate people" rather than a node ID.

import { PLAN_LIMITS } from "@penguin/protocol";

/** How one test failed, from its block in the log's FAILURES section. */
export interface FailureLines {
  /** The source line pytest marked with `>`: where the test stopped. */
  readonly assertion?: string;
  /** The first `E` line: what went wrong. */
  readonly error?: string;
}

// A section header: `____ test_name ____`, or `____ TestClass.test_name[param] ____`.
const SECTION_HEADER = /^_{3,} (.+?) _{3,}$/u;
// The banner that ends the FAILURES section, such as `=== short test summary info ===`.
const BANNER = /^={3,} .* ={3,}$/u;
const FAILURES_BANNER = /^={3,} FAILURES ={3,}$/u;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * The assertion and error line of each failing test in a pytest log, by node ID. A node ID with no
 * block in the log, as with `--tb=no`, is absent. ANSI escapes are ignored.
 */
export function failureLines(log: string, nodeIds: readonly string[]): Map<string, FailureLines> {
  const blocks = failureBlocks(log.replace(ANSI_ESCAPE, ""));
  const found = new Map<string, FailureLines>();
  for (const nodeId of nodeIds) {
    const separator = nodeId.indexOf("::");
    if (separator < 0) continue;
    const file = nodeId.slice(0, separator);
    const header = nodeId.slice(separator + 2).replaceAll("::", ".");
    const candidates = blocks.filter((block) => block.header === header);
    // Two files may hold a test of one name; the block's location lines name its file.
    const block =
      candidates.find((candidate) => candidate.lines.some((line) => line.startsWith(`${file}:`))) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (block === undefined) continue;
    const assertion = block.lines.find((line) => line.startsWith(">"));
    const error = block.lines.find((line) => line.startsWith("E "));
    found.set(nodeId, {
      ...(assertion === undefined ? {} : { assertion: clip(assertion.slice(1).trim(), PLAN_LIMITS.failureLineLength) }),
      ...(error === undefined ? {} : { error: clip(error.slice(1).trim(), PLAN_LIMITS.failureLineLength) }),
    });
  }
  return found;
}

interface FailureBlock {
  readonly header: string;
  readonly lines: string[];
}

/** The FAILURES section's blocks, one per test, in log order. */
function failureBlocks(log: string): FailureBlock[] {
  const blocks: FailureBlock[] = [];
  let inFailures = false;
  let current: FailureBlock | undefined;
  for (const line of log.split(/\r?\n/u)) {
    if (FAILURES_BANNER.test(line)) {
      inFailures = true;
      continue;
    }
    if (!inFailures) continue;
    if (BANNER.test(line)) break;
    const header = SECTION_HEADER.exec(line);
    // A frame separator inside one block is `_ _ _ _`, which the header pattern does not match.
    if (header !== null) {
      current = { header: header[1] as string, lines: [] };
      blocks.push(current);
    } else {
      current?.lines.push(line);
    }
  }
  return blocks;
}

const DEF = (name: string): RegExp => new RegExp(`^\\s*(?:async\\s+)?def\\s+${escape(name)}\\s*\\(`, "u");
const STRING_START = /^(?:[rRuU]|[rR][bB]|[bB][rR])?("""|'''|"|')/u;

/**
 * The docstring of test `name` in Python `source`, folded onto one line, or undefined when the test
 * has none. `name` is the function's name without a parametrize suffix; a method is found by its own
 * name. The text is read as written, without evaluating escapes.
 */
export function testDocstring(source: string, name: string): string | undefined {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => DEF(name).test(line));
  if (start < 0) return undefined;
  // The signature ends on the line where its parentheses close and a colon follows.
  let depth = 0;
  let end = start;
  for (; end < lines.length; end += 1) {
    const code = (lines[end] as string).replace(/#.*$/u, "");
    for (const char of code) {
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth -= 1;
    }
    if (depth <= 0 && code.trimEnd().endsWith(":")) break;
  }
  if (end >= lines.length) return undefined;
  const closing = (lines[end] as string).replace(/#.*$/u, "");
  const after = closing.slice(closing.lastIndexOf(":") + 1);
  const rest = [after, ...lines.slice(end + 1)].join("\n").replace(/^\s+/u, "");
  const opening = STRING_START.exec(rest);
  if (opening === null) return undefined;
  const quote = opening[1] as string;
  const body = rest.slice(opening[0].length);
  const close = body.indexOf(quote);
  if (close < 0) return undefined;
  const text = body.slice(0, close).split("\n").map((line) => line.trim()).join(" ").replace(/\s+/gu, " ").trim();
  return text.length === 0 ? undefined : clip(text, PLAN_LIMITS.docstringLength);
}

/** The test function's name in a pytest node ID: its last part without a parametrize suffix. */
export function testFunctionName(nodeId: string): string {
  const last = nodeId.split("::").at(-1) as string;
  const bracket = last.indexOf("[");
  return bracket < 0 ? last : last.slice(0, bracket);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
