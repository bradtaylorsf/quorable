/**
 * Python-compatible numeric formatting.
 *
 * The parity gate requires the TS engine to reproduce the Python engine's
 * numbers exactly. Python's round() and "%.2f" both perform CORRECT rounding
 * (round-half-even) on the EXACT binary value of the double — e.g.
 * round(2.675, 2) === 2.67 because 2.675 is really 2.67499999...
 * Scaling tricks with Math.round get this wrong, so we do exact BigInt
 * arithmetic on the IEEE-754 decomposition instead.
 */

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);

/** Decompose a finite double into { sign, mantissa, exp2 }: |x| = mantissa * 2^exp2. */
function decompose(x: number): { negative: boolean; mantissa: bigint; exp2: number } {
  F64[0] = x;
  const bits = U64[0]!;
  const negative = bits >> 63n === 1n;
  const biasedExp = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (biasedExp === 0) {
    // Subnormal: value = fraction * 2^-1074
    return { negative, mantissa: fraction, exp2: -1074 };
  }
  return { negative, mantissa: fraction | (1n << 52n), exp2: biasedExp - 1075 };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Round |x| = mantissa * 2^exp2 to ndigits decimal places with half-even,
 * returning the scaled integer value (i.e. round(x * 10^ndigits) exactly).
 */
function roundScaled(mantissa: bigint, exp2: number, ndigits: number): bigint {
  if (mantissa === 0n) return 0n;
  const scale = pow10(Math.max(ndigits, 0));
  let num: bigint;
  let den: bigint;
  if (exp2 >= 0) {
    num = mantissa * (1n << BigInt(exp2)) * scale;
    den = 1n;
  } else {
    num = mantissa * scale;
    den = 1n << BigInt(-exp2);
  }
  if (ndigits < 0) {
    den *= pow10(-ndigits);
  }
  const q = num / den;
  const r = num % den;
  const twice = r * 2n;
  if (twice > den) return q + 1n;
  if (twice < den) return q;
  // Exactly halfway: round to even.
  return q % 2n === 0n ? q : q + 1n;
}

/** Python round(x, ndigits) for finite doubles. Returns a double. */
export function pythonRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const { negative, mantissa, exp2 } = decompose(x);
  const scaled = roundScaled(mantissa, exp2, ndigits);
  const s = scaledToDecimalString(scaled, ndigits);
  const value = Number.parseFloat(s);
  return negative ? -value : value;
}

function scaledToDecimalString(scaled: bigint, ndigits: number): string {
  if (ndigits <= 0) {
    return (scaled * pow10(-ndigits)).toString();
  }
  const digits = scaled.toString();
  if (digits.length <= ndigits) {
    return `0.${digits.padStart(ndigits, "0")}`;
  }
  const intPart = digits.slice(0, digits.length - ndigits);
  const fracPart = digits.slice(digits.length - ndigits);
  return `${intPart}.${fracPart}`;
}

/** Python f"{x:.<n>f}" — fixed-point with correct (half-even) rounding. */
export function pyFixed(x: number, ndigits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const { negative, mantissa, exp2 } = decompose(x);
  const scaled = roundScaled(mantissa, exp2, ndigits);
  let s: string;
  if (ndigits === 0) {
    s = scaled.toString();
  } else {
    const digits = scaled.toString().padStart(ndigits + 1, "0");
    s = `${digits.slice(0, digits.length - ndigits)}.${digits.slice(digits.length - ndigits)}`;
  }
  return negative && scaled !== 0n ? `-${s}` : negative ? `-${s}` : s;
}

/**
 * Python repr() of a string — enough of it for gate findings parity:
 * quote preference, backslash/quote/newline/tab/CR escapes, \xXX for other
 * control characters. Printable non-ASCII passes through (as in Python 3).
 */
export function pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return out + quote;
}
