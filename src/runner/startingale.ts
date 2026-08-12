// The Startingale reading is surfaced as a WORD, never a raw number, exactly
// like the Tradingale site and MCP: Strong / Favorable / Moderate / Misaligned.
// Thresholds are the house values (lib/mcp STARTINGALE_THRESHOLDS): strictly
// greater than each cutoff.

export type StartingaleLabel = 'Strong' | 'Favorable' | 'Moderate' | 'Misaligned';

const STRONG = 4.5;
const FAVORABLE = 3.75;
const MODERATE = 3.25;

export function startingaleLabel(value: number): StartingaleLabel {
  if (value > STRONG) return 'Strong';
  if (value > FAVORABLE) return 'Favorable';
  if (value > MODERATE) return 'Moderate';
  return 'Misaligned';
}
