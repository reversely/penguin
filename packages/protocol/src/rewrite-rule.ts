// Rewrite rules a merge plan declares (PRD 0.4 sections 4.2 and 5.3). The contract diff alone gives
// renames, moves and renamed keywords; a type migration also needs pattern rewrites, such as
// `money.display($amount)` to `$amount.display()`. The originating agent declares each one, scoped to
// one contract of the contract diff. The check runner compiles each rule into LibCST matchers and
// applies it with Penguin's codemod (`fix:python-codemod`), then the formatter and lint autofix; nothing
// in a rule is run. A plan part is mechanical when the rules' output equals its proposed fix.
//
// The form is checked here, in the Worker. Whether a pattern parses as Python, names a use of its
// contract, and whether a replacement names only what its contract and imports provide, is checked by
// the runner, which parses the code (`services/local-bridge/analysis/python_codemod.py`).

export const REWRITE_RULE_KINDS = ["expression", "annotation"] as const;
export type RewriteRuleKind = (typeof REWRITE_RULE_KINDS)[number];

export const REWRITE_RULE_LIMITS = { rules: 32, text: 500, imports: 8, id: 64 } as const;

/** A name a replacement may use: `from <module> import <name>`, added where the rule writes it. */
export interface RewriteRuleImport {
  readonly module: string;
  readonly name: string;
}

export interface RewriteRule {
  /** Lowercase words joined by `-`, unique in the plan. */
  readonly id: string;
  /** The contract the rule migrates, `path::symbol`, one the contract diff touches. */
  readonly contract: string;
  /**
   * `expression`: each expression the pattern matches becomes the replacement. The pattern must name
   * a use of the contract, written through its module's last name (`money.display`) or the symbol
   * alone; it matches however the file imports it. `annotation`: a type annotation equal to the
   * pattern becomes the replacement where it annotates a function's return whose every return is a
   * call of the contract, or a parameter passed by name to a call of the contract.
   */
  readonly kind: RewriteRuleKind;
  /** A Python expression; `$name` placeholders match any expression (expression rules only). */
  readonly pattern: string;
  /** A Python expression using the pattern's placeholders, the contract's module and the imports. */
  readonly replacement: string;
  /** From the contract's module or the standard library. */
  readonly imports: readonly RewriteRuleImport[];
}

const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTRACT = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,511}\.py::[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_]{0,127})*$/u;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const PLACEHOLDER = /\$([a-z_][a-z0-9_]{0,31})/gu;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function placeholders(text: string): string[] | undefined {
  if (text.replace(PLACEHOLDER, "").includes("$")) return undefined;
  return [...text.matchAll(PLACEHOLDER)].map((found) => found[1] as string);
}

/** Why `value` is no rewrite rule, or null when its form is one. Unknown fields are refused. */
export function rewriteRuleProblem(value: unknown): string | null {
  if (!isRecord(value)) return "a rule must be an object";
  const extra = Object.keys(value).filter((key) => !["id", "contract", "kind", "pattern", "replacement", "imports"].includes(key));
  if (extra.length > 0) return `unknown field ${extra[0]}`;
  const { id, contract, kind, pattern, replacement, imports } = value;
  if (typeof id !== "string" || id.length > REWRITE_RULE_LIMITS.id || !RULE_ID.test(id)) return "id must be lowercase words joined by '-'";
  if (typeof contract !== "string" || !CONTRACT.test(contract)) return `rule ${id}: contract must be path::symbol, a module-level name`;
  if (!(REWRITE_RULE_KINDS as readonly unknown[]).includes(kind)) return `rule ${id}: kind must be one of ${REWRITE_RULE_KINDS.join(", ")}`;
  for (const [key, text] of [["pattern", pattern], ["replacement", replacement]] as const) {
    if (typeof text !== "string" || text.trim().length === 0 || text.length > REWRITE_RULE_LIMITS.text) {
      return `rule ${id}: ${key} must be a Python expression of at most ${REWRITE_RULE_LIMITS.text} characters`;
    }
  }
  const bound = placeholders(pattern as string);
  const used = placeholders(replacement as string);
  if (bound === undefined || used === undefined) return `rule ${id}: a $ must start a placeholder such as $amount`;
  if (new Set(bound).size !== bound.length) return `rule ${id}: a placeholder appears twice in the pattern`;
  const unbound = used.find((name) => !bound.includes(name));
  if (unbound !== undefined) return `rule ${id}: the replacement uses $${unbound}, which the pattern does not bind`;
  if (kind === "annotation" && (bound.length > 0 || used.length > 0)) return `rule ${id}: an annotation rule takes no placeholders`;
  if (!Array.isArray(imports) || imports.length > REWRITE_RULE_LIMITS.imports) return `rule ${id}: imports must list at most ${REWRITE_RULE_LIMITS.imports}`;
  for (const item of imports) {
    if (!isRecord(item) || Object.keys(item).length !== 2 || typeof item["module"] !== "string" || !DOTTED.test(item["module"]) || typeof item["name"] !== "string" || !IDENTIFIER.test(item["name"])) {
      return `rule ${id}: an import is { module, name }, a dotted module and a name`;
    }
  }
  return null;
}

/** A plan's rules, or a message naming the first that breaks the form. Absent is no rules. */
export function parseRewriteRules(value: unknown): RewriteRule[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "rules must be an array";
  if (value.length > REWRITE_RULE_LIMITS.rules) return `a plan declares at most ${REWRITE_RULE_LIMITS.rules} rules`;
  const rules: RewriteRule[] = [];
  for (const [index, raw] of value.entries()) {
    const problem = rewriteRuleProblem(raw);
    if (problem !== null) return `rules[${index}]: ${problem}`;
    const rule = raw as RewriteRule;
    if (rules.some((each) => each.id === rule.id)) return `rules[${index}]: two rules share the id ${rule.id}`;
    rules.push({
      id: rule.id,
      contract: rule.contract,
      kind: rule.kind,
      pattern: rule.pattern,
      replacement: rule.replacement,
      imports: rule.imports.map(({ module, name }) => ({ module, name })),
    });
  }
  return rules;
}

/** The same text for the same rules in the same order, whatever their fields' order. */
export function rewriteRulesKey(rules: readonly RewriteRule[]): string {
  return JSON.stringify(rules.map((rule) => [rule.id, rule.contract, rule.kind, rule.pattern, rule.replacement, rule.imports.map((item) => [item.module, item.name])]));
}

/** The repository path of a rule's contract: the part before `::`. */
export function rewriteRuleContractPath(rule: Pick<RewriteRule, "contract">): string {
  return rule.contract.slice(0, rule.contract.indexOf("::"));
}
