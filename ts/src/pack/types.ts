/**
 * The Pack contract (CONTRACT.md) in TS: everything domain-specific the
 * engine needs. With generic packs (M3), 90% of use cases never see code —
 * a rubric YAML generates the schemas at load time. The Pack interface
 * remains the only boundary between domain and engine.
 */

import type { z } from "zod";

import type { KeywordRule } from "../engine/agreement.js";
import type { Gate } from "../engine/gates.js";
import type { ShipGatesConfig } from "../engine/scoring.js";

export interface Pack {
  name: string;
  reviewSchema: z.ZodType<Record<string, unknown>>;
  synthesisSchema: z.ZodType<Record<string, unknown>>;
  scoreDimensions: string[];
  verdictField: string;
  verdictCategories: string[];
  canonicalUnits: string[];
  unitField: string;
  unitListField: string;
  unitScoreField: string | null;
  unitKeywordRules: KeywordRule[];
  primaryDocName: string;
  docTypeMarkers: Record<string, string[]>;
  mechanicalGates: Gate[];
  shipGates: ShipGatesConfig;
  drafterEnabled: boolean;
  heldOutRecommendedDocs: string[];
  /** Dimension scale bounds (from the rubric), used by prompts + cold reader. */
  dimensionScales: Record<string, [number, number]>;
  /** Dimension weights (rubric `weight:`) — also the ship-gate weights. */
  dimensionWeights: Record<string, number>;
}

export class PackError extends Error {
  override name = "PackError";
}
