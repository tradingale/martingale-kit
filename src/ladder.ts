// The ladder formula: from Tradingale's dimensionless parameters + the
// user's budget + the live entry price to a complete, venue-ready plan.
//
// ⚠ THE rule that breaks most integrations when missed:
// multipliers scale QUANTITIES (base units), never dollar costs.
//   qty[n] = qty[n-1] * multipliers[n-2]
// Because deeper levels buy at lower prices, the cost ratio between levels
// is smaller than the quantity multiplier.
//
// Handbook section 2: https://tradingale.com/handbook/sequence-automation.md

import type { Ladder, LadderLevel, SequenceParams, VenueGrids } from './types.js';
import { snapPrice, snapQuantity } from './grid.js';

/** Thrown when the inputs cannot produce a well-formed ladder. */
export class LadderError extends Error {}

function validate(params: SequenceParams, budget: number, entryPrice: number): void {
  if (!(budget > 0)) throw new LadderError('budget must be > 0');
  if (!(entryPrice > 0)) throw new LadderError('entryPrice must be > 0');
  if (!(params.deltaPrice > 0 && params.deltaPrice < 1)) {
    throw new LadderError('deltaPrice must be a fraction in (0, 1)');
  }
  if (!Number.isInteger(params.nbRounds) || params.nbRounds < 2) {
    throw new LadderError('nbRounds must be an integer >= 2');
  }
  if (params.multipliers.length !== params.nbRounds - 1) {
    throw new LadderError(
      `multipliers must have nbRounds - 1 entries (got ${params.multipliers.length}, expected ${params.nbRounds - 1})`,
    );
  }
  if (params.multipliers.some((m) => !(m > 0))) throw new LadderError('multipliers must be > 0');
  if (!(params.initialBetRatio > 0 && params.initialBetRatio < 1)) {
    throw new LadderError('initialBetRatio must be a fraction in (0, 1)');
  }
  if (params.deltaPrice * (params.nbRounds - 1) >= 1) {
    throw new LadderError('deltaPrice * (nbRounds - 1) must stay below 1 (prices must remain positive)');
  }
}

/**
 * Compute the full ladder.
 *
 * Steps (handbook section 2):
 *  1. price[n] = entry * (1 - delta * (n - 1)), level 1 = market entry
 *  2. qty[1]   = budget * initialBetRatio / entry
 *  3. qty[n]   = qty[n-1] * multipliers[n-2]        (QUANTITIES, not costs)
 *  4. scale level 2+ quantities so total cost equals the budget exactly
 *  5. exit[1]  = entry * (1 + delta); exit[n] = price[n-1]
 *  6. optional: snap prices/quantities to the venue grids (exit UP, buy DOWN,
 *     quantity FLOOR) and recompute costs
 */
export function computeLadder(
  params: SequenceParams,
  budget: number,
  entryPrice: number,
  grids?: VenueGrids,
): Ladder {
  validate(params, budget, entryPrice);
  const { deltaPrice, nbRounds, multipliers, initialBetRatio } = params;

  // 1-3. Prices and raw quantities.
  const prices: number[] = [];
  const quantities: number[] = [];
  for (let n = 1; n <= nbRounds; n++) {
    prices.push(entryPrice * (1 - deltaPrice * (n - 1)));
    quantities.push(n === 1
      ? (budget * initialBetRatio) / entryPrice
      : quantities[n - 2] * multipliers[n - 2]);
  }

  // 4. Scale level 2+ so the total cost equals the budget exactly.
  const cost1 = quantities[0] * prices[0];
  const deeperCost = quantities.slice(1).reduce((sum, q, i) => sum + q * prices[i + 1], 0);
  if (deeperCost > 0) {
    const scale = (budget - cost1) / deeperCost;
    if (!(scale > 0)) {
      throw new LadderError('initialBetRatio leaves nothing for deeper levels at this budget');
    }
    for (let i = 1; i < quantities.length; i++) quantities[i] *= scale;
  }

  // 5-6. Exits, optional snapping, assembly.
  const levels: LadderLevel[] = [];
  let cumulative = 0;
  for (let n = 1; n <= nbRounds; n++) {
    const rawBuy = prices[n - 1];
    const rawExit = n === 1 ? entryPrice * (1 + deltaPrice) : prices[n - 2];
    const buyPrice = grids ? snapPrice(rawBuy, 'buy', grids.priceIncrement) : rawBuy;
    const exitPrice = grids ? snapPrice(rawExit, 'sell', grids.priceIncrement) : rawExit;
    const quantity = grids ? snapQuantity(quantities[n - 1], grids.qtyStep) : quantities[n - 1];
    cumulative += quantity;
    levels.push({
      level: n,
      buyPrice,
      quantity,
      cost: quantity * buyPrice,
      cumulativeQuantity: cumulative,
      exitPrice,
    });
  }

  return {
    levels,
    totalCost: levels.reduce((sum, l) => sum + l.cost, 0),
    budget,
    entryPrice,
    params,
    snapped: Boolean(grids),
  };
}

/**
 * Minimum viable budget for a venue's grids (handbook section 5).
 *
 * Level 1 carries the smallest quantity of the ladder, so it hits the
 * venue's minimums first. `safetyFactorSteps` (default 100) keeps grid
 * flooring negligible: a quantity only a few steps wide gets distorted by
 * several percent when floored.
 */
export function budgetMin(
  params: Pick<SequenceParams, 'initialBetRatio'>,
  entryPrice: number,
  grids: VenueGrids,
  safetyFactorSteps = 100,
): number {
  if (!(entryPrice > 0)) throw new LadderError('entryPrice must be > 0');
  if (!(params.initialBetRatio > 0)) throw new LadderError('initialBetRatio must be > 0');
  const qtyFloor = Math.max(grids.minOrderSize ?? 0, safetyFactorSteps * (grids.qtyStep ?? 0));
  const fromQuantity = (qtyFloor * entryPrice) / params.initialBetRatio;
  const fromNotional = grids.minNotional ? grids.minNotional / params.initialBetRatio : 0;
  return Math.max(fromQuantity, fromNotional);
}

/**
 * Verify a ladder clears the venue's minimums with margin. Returns the list
 * of violations (empty = good to go). Runners should refuse to start and
 * surface `budgetMin` to the user instead of placing a distorted ladder.
 */
export function checkLadderAgainstGrids(ladder: Ladder, grids: VenueGrids): string[] {
  const problems: string[] = [];
  const level1 = ladder.levels[0];
  if (grids.minOrderSize && level1.quantity < grids.minOrderSize) {
    problems.push(`level 1 quantity ${level1.quantity} is below minOrderSize ${grids.minOrderSize}`);
  }
  for (const level of ladder.levels) {
    if (grids.minNotional && level.cost < grids.minNotional) {
      problems.push(`level ${level.level} cost ${level.cost.toFixed(2)} is below minNotional ${grids.minNotional}`);
    }
    if (grids.qtyStep && level.quantity > 0 && level.quantity < 100 * grids.qtyStep) {
      problems.push(
        `level ${level.level} quantity ${level.quantity} is under 100 quantity steps: grid flooring will distort the structure`,
      );
    }
  }
  return problems;
}
