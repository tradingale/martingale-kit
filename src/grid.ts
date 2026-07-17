// Directional grid snapping. The rule that keeps completions above
// break-even: SELL prices round UP to the grid, BUY prices round DOWN,
// quantities FLOOR to the step. Blind rounding on a sub-$1 asset moved
// fills by over 1% per level in our production era; snap directionally
// and the error always works in the position's favor.
//
// See handbook section 5: https://tradingale.com/handbook/sequence-automation.md

const EPSILON = 1e-9;

function decimalsOf(increment: number): number {
  if (!Number.isFinite(increment) || increment <= 0) return 2;
  const s = increment.toString();
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  return s.split('.')[1]?.length ?? 0;
}

/** Round a value to the grid implied by `increment`, in `direction`. */
function snapToIncrement(value: number, increment: number, direction: 'up' | 'down'): number {
  const ticks = direction === 'up'
    ? Math.ceil(value / increment - EPSILON)
    : Math.floor(value / increment + EPSILON);
  return Number((ticks * increment).toFixed(decimalsOf(increment)));
}

/**
 * Fallback decimal count when a venue declares no price grid: scale with
 * price magnitude (~5 significant digits) so micro-priced assets are never
 * crushed by a fixed decimal count. Capped at 9.
 */
export function fallbackDecimals(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 2;
  return Math.min(9, Math.max(2, 4 - Math.floor(Math.log10(price))));
}

/**
 * Snap a price directionally: sells UP (never below theoretical break-even),
 * buys DOWN (never overpay a level).
 */
export function snapPrice(price: number, side: 'buy' | 'sell', priceIncrement: number | null): number {
  if (priceIncrement && priceIncrement > 0) {
    return snapToIncrement(price, priceIncrement, side === 'sell' ? 'up' : 'down');
  }
  const decimals = fallbackDecimals(price);
  const factor = 10 ** decimals;
  return (side === 'sell' ? Math.ceil(price * factor - EPSILON) : Math.floor(price * factor + EPSILON)) / factor;
}

/** Floor a quantity to the step. Never round up a quantity you do not hold. */
export function snapQuantity(quantity: number, qtyStep: number | null): number {
  if (qtyStep && qtyStep > 0) {
    return snapToIncrement(quantity, qtyStep, 'down');
  }
  return quantity;
}
