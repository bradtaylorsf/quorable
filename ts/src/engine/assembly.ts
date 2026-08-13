/**
 * Per-persona document assembly, ported from assembly.py.
 *
 * Tier 1 documents go to every Stage 1 persona. Tier 2 documents are routed
 * per the manifest's send_to field. Tier 3 documents are never sent.
 */

import type { DocumentModel, ManifestEntry } from "./manifest.js";

function matchesPersona(entry: ManifestEntry, persona: string): boolean {
  for (const target of entry.sendTo) {
    if (target === "stage1") return true;
    if (target === `stage1_${persona}`) return true;
  }
  return false;
}

export function assembleForPersona(
  persona: string,
  entries: ManifestEntry[],
  documents: Record<string, DocumentModel>,
): DocumentModel[] {
  const result: DocumentModel[] = [];
  for (const entry of entries) {
    if (entry.tier === 3) continue;
    if (entry.tier === 1) {
      const doc = documents[entry.name];
      if (doc) result.push(doc);
    } else if (entry.tier === 2 && matchesPersona(entry, persona)) {
      const doc = documents[entry.name];
      if (doc) result.push(doc);
    }
  }
  return result;
}

export function assembleForStage2(
  entries: ManifestEntry[],
  documents: Record<string, DocumentModel>,
): DocumentModel[] {
  const result: DocumentModel[] = [];
  for (const entry of entries) {
    if (entry.tier === 3) continue;
    if (entry.sendTo.includes("stage2")) {
      const doc = documents[entry.name];
      if (doc) result.push(doc);
    }
  }
  return result;
}

export function assembleForStage3(
  entries: ManifestEntry[],
  documents: Record<string, DocumentModel>,
): DocumentModel[] {
  const result: DocumentModel[] = [];
  for (const entry of entries) {
    if (entry.sendTo.includes("stage3")) {
      const doc = documents[entry.name];
      if (doc) result.push(doc);
    }
  }
  return result;
}

export function assembleForDraft(
  entries: ManifestEntry[],
  documents: Record<string, DocumentModel>,
  exclude: Set<string> = new Set(),
): DocumentModel[] {
  const result: DocumentModel[] = [];
  for (const entry of entries) {
    if (entry.tier === 3 || exclude.has(entry.name)) continue;
    if (entry.sendTo.includes("draft")) {
      const doc = documents[entry.name];
      if (doc) result.push(doc);
    }
  }
  return result;
}
