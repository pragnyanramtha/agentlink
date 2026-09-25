export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length] as number;
}

/** Closest candidate within a small edit distance (or a prefix match), for "did you mean". */
export function closest(input: string, candidates: string[]): string | undefined {
  const scored = candidates
    .filter((c) => c !== input)
    .map((c) => ({ c, d: c.startsWith(input) || input.startsWith(c) ? 1 : editDistance(input, c) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(input.length / 4)))
    .sort((x, y) => x.d - y.d);
  return scored[0]?.c;
}

export const didYouMean = (input: string, candidates: string[]): string => {
  const guess = closest(input, candidates);
  return guess ? ` (did you mean "${guess}"?)` : "";
};
