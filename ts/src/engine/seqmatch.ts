/**
 * Faithful port of Python difflib.SequenceMatcher.ratio() over strings,
 * including the autojunk heuristic (sequences >= 200 chars purge "popular"
 * elements). Regression fuzzy-matching parity depends on this being exact —
 * pinned by fixtures/parity/sequence_matcher_cases.json.
 */

interface Match {
  a: number;
  b: number;
  size: number;
}

export class SequenceMatcher {
  private a = "";
  private b = "";
  private b2j = new Map<string, number[]>();
  private bjunk = new Set<string>();

  constructor(a = "", b = "") {
    this.setSeqs(a, b);
  }

  setSeqs(a: string, b: string): void {
    this.a = a;
    this.setSeq2(b);
  }

  private setSeq2(b: string): void {
    this.b = b;
    this.chainB();
  }

  private chainB(): void {
    const b = this.b;
    const b2j = new Map<string, number[]>();
    for (let i = 0; i < b.length; i++) {
      const elt = b[i]!;
      const indices = b2j.get(elt);
      if (indices) indices.push(i);
      else b2j.set(elt, [i]);
    }
    // No isjunk in our usage. Autojunk: purge popular elements when n >= 200.
    this.bjunk = new Set();
    const n = b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      const popular = new Set<string>();
      for (const [elt, idxs] of b2j) {
        if (idxs.length > ntest) popular.add(elt);
      }
      for (const elt of popular) b2j.delete(elt);
    }
    this.b2j = b2j;
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    const { a, b, b2j, bjunk } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i]!) ?? [];
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (
      besti > alo &&
      bestj > blo &&
      !bjunk.has(b[bestj - 1]!) &&
      a[besti - 1] === b[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !bjunk.has(b[bestj + bestsize]!) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    while (
      besti > alo &&
      bestj > blo &&
      bjunk.has(b[bestj - 1]!) &&
      a[besti - 1] === b[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      bjunk.has(b[bestj + bestsize]!) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return { a: besti, b: bestj, size: bestsize };
  }

  private getMatchingBlocks(): Match[] {
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const matchingBlocks: Match[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      if (x.size > 0) {
        matchingBlocks.push(x);
        if (alo < x.a && blo < x.b) queue.push([alo, x.a, blo, x.b]);
        if (x.a + x.size < ahi && x.b + x.size < bhi) {
          queue.push([x.a + x.size, ahi, x.b + x.size, bhi]);
        }
      }
    }
    matchingBlocks.sort((p, q) => p.a - q.a || p.b - q.b || p.size - q.size);

    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Match[] = [];
    for (const { a: i2, b: j2, size: k2 } of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
    nonAdjacent.push({ a: la, b: lb, size: 0 });
    return nonAdjacent;
  }

  ratio(): number {
    let matches = 0;
    for (const block of this.getMatchingBlocks()) matches += block.size;
    const total = this.a.length + this.b.length;
    if (total === 0) return 1.0;
    return (2.0 * matches) / total;
  }
}

/** difflib.SequenceMatcher(None, a, b).ratio() */
export function sequenceRatio(a: string, b: string): number {
  return new SequenceMatcher(a, b).ratio();
}
