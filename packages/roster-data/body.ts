/** Weight and height are sourced bios. Strength is a bounded gameplay estimate. */
export function estimateStrength(height: number, weight?: number): number | undefined {
  if (weight === undefined || !Number.isFinite(height) || !Number.isFinite(weight)) return undefined;
  const bmi = weight / (height * height);
  return Math.round(Math.max(44, Math.min(96, 64 + (weight - 93) * 0.49 + (bmi - 24) * 1.5)));
}
