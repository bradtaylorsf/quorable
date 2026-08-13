/**
 * Mechanical (non-LLM) gate framework, ported from the Python engine.
 *
 * A gate is a named deterministic check over the primary document text.
 * Gates never consult a model; failures become results, never crashes.
 * Finding strings are parity-pinned against fixtures/parity/gate_cases.json.
 */

import { pyRepr } from "./pyformat.js";

export interface GateResult {
  passed: boolean;
  findings: string[];
}

export type GateFn = (primaryText: string, project: unknown) => GateResult;

export interface Gate {
  name: string;
  fn: GateFn;
}

export function runGate(gate: Gate, primaryText: string, project: unknown = null): GateResult {
  try {
    return gate.fn(primaryText, project);
  } catch (exc) {
    return {
      passed: false,
      findings: [`gate '${gate.name}' crashed: ${exc instanceof Error ? exc.message : exc}`],
    };
  }
}

/** Run every gate; failures become results, never crashes. */
export function runGates(
  gates: Gate[],
  primaryText: string,
  project: unknown = null,
): Record<string, GateResult> {
  const results: Record<string, GateResult> = {};
  for (const gate of gates) {
    results[gate.name] = runGate(gate, primaryText, project);
  }
  return results;
}

export function allGatesPassed(results: Record<string, GateResult>): boolean {
  return Object.values(results).every((r) => r.passed);
}

// ---------------------------------------------------------------------------
// Gate batteries
// ---------------------------------------------------------------------------

const WORD_RE = /\S+/g;

function countWords(text: string): number {
  return (text.match(WORD_RE) ?? []).length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Python str.splitlines() line-break set (close enough for document text). */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  // splitlines() drops a trailing empty segment after a final line break.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Extract a markdown section's body by heading title (any # level). */
function extractSection(text: string, section: string): string | null {
  const headingRe = new RegExp(`^(#{1,6})\\s+${escapeRegExp(section)}\\s*$`, "im");
  const m = headingRe.exec(text);
  if (m === null) return null;
  const level = m[1]!.length;
  const rest = text.slice(m.index + m[0].length);
  const nextRe = new RegExp(`^#{1,${level}}\\s+\\S`, "m");
  const nxt = nextRe.exec(rest);
  return nxt ? rest.slice(0, nxt.index) : rest;
}

/**
 * Fail when the counted region exceeds maxWords. Counting scope (mutually
 * exclusive): whole document (default), one named markdown `section`, or
 * only the remainder of lines starting with `linePrefix` (e.g. "VO:").
 */
export function wordCountGate(
  maxWords: number,
  opts: { section?: string | null; linePrefix?: string | null } = {},
): Gate {
  const section = opts.section ?? null;
  const linePrefix = opts.linePrefix ?? null;
  if (section !== null && linePrefix !== null) {
    throw new Error("wordCountGate: pass section OR linePrefix, not both");
  }

  const name = section
    ? `word_count_${section.toLowerCase().replace(/ /g, "_")}`
    : "word_count";
  const prefixLabel = linePrefix ? linePrefix.replace(/:+$/, "").trim() : null;

  const fn: GateFn = (primaryText) => {
    let target = primaryText;
    let scope = "document";
    if (section !== null) {
      const extracted = extractSection(primaryText, section);
      if (extracted === null) {
        return {
          passed: false,
          findings: [
            `section '${section}' not found — cannot verify its word count ` +
              `(missing section fails the gate)`,
          ],
        };
      }
      target = extracted;
      scope = `section '${section}'`;
    } else if (linePrefix !== null) {
      const matchedLines = splitLines(primaryText)
        .map((line) => line.trimStart())
        .filter((line) => line.startsWith(linePrefix))
        .map((line) => line.slice(linePrefix.length));
      if (matchedLines.length === 0) {
        return {
          passed: false,
          findings: [
            `no lines start with '${linePrefix}' — cannot verify the ` +
              `${prefixLabel} word count (missing content fails the gate)`,
          ],
        };
      }
      const count = countWords(matchedLines.join("\n"));
      if (count > maxWords) {
        return {
          passed: false,
          findings: [`${count} ${prefixLabel} words > ${maxWords} (max ${maxWords})`],
        };
      }
      return { passed: true, findings: [] };
    }
    const count = countWords(target);
    if (count > maxWords) {
      return {
        passed: false,
        findings: [`${scope} is ${count} words (max ${maxWords})`],
      };
    }
    return { passed: true, findings: [] };
  };

  return { name, fn };
}

/**
 * Fail on known-bad aliases of canonical terms. Alias matching is
 * case-sensitive and word-boundary based ((?<!\w)alias(?!\w)).
 *
 * Parity note: Python's \w is Unicode; JS's is ASCII. Identical for ASCII
 * terms — keep non-ASCII canonical terms in mind if they ever appear.
 */
export function termLintGate(canonicalTerms: Record<string, string[]>): Gate {
  const fn: GateFn = (primaryText) => {
    const findings: string[] = [];
    for (const [canonical, aliases] of Object.entries(canonicalTerms)) {
      for (const alias of aliases) {
        if (alias === canonical) continue;
        const pattern = new RegExp(`(?<!\\w)${escapeRegExp(alias)}(?!\\w)`, "g");
        const hits = primaryText.match(pattern) ?? [];
        if (hits.length > 0) {
          findings.push(
            `found '${alias}' ×${hits.length} — canonical spelling is '${canonical}'`,
          );
        }
      }
    }
    return { passed: findings.length === 0, findings };
  };
  return { name: "term_lint", fn };
}

/** Fail when any banned regex pattern appears in the document. */
export function bannedElementsGate(patterns: string[]): Gate {
  const compiled = patterns.map((p) => new RegExp(p, "m"));
  const fn: GateFn = (primaryText) => {
    const findings: string[] = [];
    for (let i = 0; i < patterns.length; i++) {
      const m = compiled[i]!.exec(primaryText);
      if (m) {
        const snippet = splitLines(primaryText.slice(m.index, m.index + 60))[0] ?? "";
        findings.push(
          `banned pattern ${pyRepr(patterns[i]!)} matched at char ${m.index}: ` +
            `${pyRepr(snippet)}`,
        );
      }
    }
    return { passed: findings.length === 0, findings };
  };
  return { name: "banned_elements", fn };
}
