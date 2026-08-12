import { describe, it, expect } from 'vitest';
import { startingaleLabel } from '../src/runner/startingale.js';

describe('startingaleLabel', () => {
  it('maps to the house thresholds (strictly greater than each cutoff)', () => {
    expect(startingaleLabel(4.6)).toBe('Strong');
    expect(startingaleLabel(4.5)).toBe('Favorable'); // equal to STRONG, not greater
    expect(startingaleLabel(4.25)).toBe('Favorable');
    expect(startingaleLabel(3.76)).toBe('Favorable');
    expect(startingaleLabel(3.75)).toBe('Moderate'); // equal to FAVORABLE
    expect(startingaleLabel(3.3)).toBe('Moderate');
    expect(startingaleLabel(3.25)).toBe('Misaligned'); // equal to MODERATE
    expect(startingaleLabel(2.73)).toBe('Misaligned');
    expect(startingaleLabel(0)).toBe('Misaligned');
  });
});
