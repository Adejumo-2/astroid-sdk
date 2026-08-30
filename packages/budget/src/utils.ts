/**
 * Budget utilization analysis helpers.
 *
 * Pure, local arithmetic that turns a budget's active limit and its matching
 * transaction history into structured spending statistics (spent, remaining,
 * utilization, over-budget). No network or database access, so it behaves
 * identically in Node and browser runtimes.
 *
 * @module
 */

import type { Budget, BudgetPeriod, DecimalString, IsoDateTime, Transaction } from '@astroid/types';

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/** Per-asset spending statistics when transactions span multiple currencies. */
export interface AssetUtilization {
  /** Asset identifier (e.g. `"XLM"`, `"USDC"`, `"USDC:G...Issuer"`). */
  asset: string;
  /** The budget's active limit, attributed to this asset. */
  totalLimit: DecimalString;
  /** Sum of matching transaction amounts for this asset. */
  spentAmount: DecimalString;
  /** `totalLimit - spentAmount` (clamped at 0). */
  remainingAmount: DecimalString;
  /** Share (0-100) of the limit consumed, rounded to 4 decimal places. */
  utilizationPercentage: number;
  /** Whether this asset's spending exceeds its attributed limit. */
  isOverBudget: boolean;
}

/** The aggregate result of running a budget against its transactions. */
export interface BudgetUtilizationResult {
  /** The budget's active limit. */
  totalLimit: DecimalString;
  /** Sum of all matching transaction amounts across every asset. */
  spentAmount: DecimalString;
  /** `totalLimit - spentAmount` (clamped at 0). */
  remainingAmount: DecimalString;
  /** Share (0-100) of the limit consumed, rounded to 4 decimal places. */
  utilizationPercentage: number;
  /** Whether aggregate spending exceeds the budget limit. */
  isOverBudget: boolean;
  /** Per-asset breakdown of spending. */
  assets: AssetUtilization[];
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Decimal-string addition.  Both operands are non-negative finite decimals.
 * Scales both to the longer fractional length using integer arithmetic so no
 * floating-point error is introduced.
 */
function decAdd(a: DecimalString | number, b: DecimalString | number): DecimalString {
  const [intA, fracA = ''] = String(a).split('.');
  const [intB, fracB = ''] = String(b).split('.');
  const scaleA = fracA.length;
  const scaleB = fracB.length;
  const maxScale = Math.max(scaleA, scaleB);

  const aScaled = BigInt(intA + fracA.padEnd(scaleA, '0') + '0'.repeat(maxScale - scaleA));
  const bScaled = BigInt(intB + fracB.padEnd(scaleB, '0') + '0'.repeat(maxScale - scaleB));
  const result = (aScaled + bScaled).toString();

  if (maxScale === 0) return result;

  const padded = result.padStart(maxScale + 1, '0');
  const intPart = padded.slice(0, padded.length - maxScale) || '0';
  const fracPart = padded.slice(padded.length - maxScale);
  return `${intPart}.${fracPart.replace(/0+$/, '')}`;
}

/**
 * Decimal-string subtraction (`a - b`).  Returns `"0"` when `b > a` so that
 * remaining budget never goes negative.  Both operands are non-negative
 * finite decimals.
 */
function decSub(a: DecimalString | number, b: DecimalString | number): DecimalString {
  const [intA, fracA = ''] = String(a).split('.');
  const [intB, fracB = ''] = String(b).split('.');
  const scaleA = fracA.length;
  const scaleB = fracB.length;
  const maxScale = Math.max(scaleA, scaleB);

  const aScaled = BigInt(intA + fracA.padEnd(scaleA, '0') + '0'.repeat(maxScale - scaleA));
  const bScaled = BigInt(intB + fracB.padEnd(scaleB, '0') + '0'.repeat(maxScale - scaleB));

  const diff = aScaled - bScaled;
  if (diff <= 0n) return '0';

  const result = diff.toString();
  if (maxScale === 0) return result;

  const padded = result.padStart(maxScale + 1, '0');
  const intPart = padded.slice(0, padded.length - maxScale) || '0';
  const fracPart = padded.slice(padded.length - maxScale);
  return `${intPart}.${fracPart.replace(/0+$/, '')}`;
}

/** Compare two non-negative decimal strings.  Returns -1, 0, or 1. */
function decCmp(a: DecimalString | number, b: DecimalString | number): -1 | 0 | 1 {
  const [intA, fracA = ''] = String(a).split('.');
  const [intB, fracB = ''] = String(b).split('.');
  const scaleA = fracA.length;
  const scaleB = fracB.length;
  const maxScale = Math.max(scaleA, scaleB);

  const aScaled = BigInt(intA + fracA.padEnd(scaleA, '0') + '0'.repeat(maxScale - scaleA));
  const bScaled = BigInt(intB + fracB.padEnd(scaleB, '0') + '0'.repeat(maxScale - scaleB));

  if (aScaled < bScaled) return -1;
  if (aScaled > bScaled) return 1;
  return 0;
}

/** Whether the decimal representation of `a` is `> 0`. */
function decGtZero(a: DecimalString | number): boolean {
  return decCmp(a, 0) === 1;
}

/**
 * Format a non-negative integer as a decimal string with `digits` fraction
 * digits, e.g. `intToDecimal("5000000", 6)` → `"5.000000"`.
 */
function intToDecimal(intStr: string, digits: number): DecimalString {
  if (digits === 0) return intStr;

  const padded = intStr.padStart(digits + 1, '0');
  const intPart = padded.slice(0, padded.length - digits) || '0';
  const fracPart = padded.slice(padded.length - digits);
  return `${intPart}.${fracPart}`;
}

/**
 * Compute `spent / limit` as a percentage (0-100) rounded to 6 decimal
 * places, using integer arithmetic so no floating-point error is introduced.
 * Returns `0` when the limit is absent or zero to avoid division by zero.
 */
function utilizationPercent(spent: DecimalString, limit: DecimalString): number {
  if (decCmp(limit, 0) === 0) return 0;

  // Scale both operands to the longer fractional length so the ratio is exact.
  const [, spentFrac = ''] = String(spent).split('.');
  const [, limitFrac = ''] = String(limit).split('.');
  const maxScale = Math.max(spentFrac.length, limitFrac.length);
  const spentScaled = decScaleUp(spent, maxScale);
  const limitScaled = decScaleUp(limit, maxScale);

  // percentage * 1e6, rounded half-up.
  const scaled =
    (BigInt(spentScaled) * 100000000n + BigInt(limitScaled) / 2n) / BigInt(limitScaled);
  return Number(intToDecimal(scaled.toString(), 6));
}

/**
 * Return the decimal string of `value` scaled up to exactly `scale` fraction
 * digits (padding with zeros, dropping the decimal point) as a plain integer
 * string suitable for `BigInt`.
 */
function decScaleUp(value: DecimalString, scale: number): string {
  const [intPart, frac = ''] = String(value).split('.');
  return intPart + frac.padEnd(scale, '0');
}

/** ISO-8601 day boundary (00:00 UTC) for a given date. */
function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}

function addYears(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCFullYear(r.getUTCFullYear() + n);
  return r;
}

/**
 * Determine the start and end of the active budget window.  Boundaries are
 * normalised to 00:00 UTC for day-level periods so cross-midnight scenarios
 * behave correctly.
 */
function getWindow(period: BudgetPeriod, periodStart: IsoDateTime): { start: Date; end: Date } {
  const ps = new Date(periodStart);

  switch (period) {
    case 'ONE_TIME':
      return { start: ps, end: addYears(ps, 100) };

    case 'DAILY': {
      const dayStart = startOfDay(ps);
      return { start: dayStart, end: addDays(dayStart, 1) };
    }

    case 'WEEKLY': {
      const dayStart = startOfDay(ps);
      const dow = dayStart.getUTCDay(); // 0=Sun 1=Mon … 6=Sat
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = addDays(dayStart, mondayOffset);
      return { start: monday, end: addDays(monday, 7) };
    }

    case 'MONTHLY': {
      const monthStart = new Date(Date.UTC(ps.getUTCFullYear(), ps.getUTCMonth(), 1));
      return { start: monthStart, end: addMonths(monthStart, 1) };
    }

    case 'QUARTERLY': {
      const q = Math.floor(ps.getUTCMonth() / 3);
      const quarterStart = new Date(Date.UTC(ps.getUTCFullYear(), q * 3, 1));
      return { start: quarterStart, end: addMonths(quarterStart, 3) };
    }

    case 'YEARLY': {
      const yearStart = new Date(Date.UTC(ps.getUTCFullYear(), 0, 1));
      return { start: yearStart, end: addYears(yearStart, 1) };
    }

    default: {
      // Defensive — BudgetPeriod is a closed union, so this is unreachable.
      throw new Error(`Unhandled budget period: ${String(period)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compute current utilization statistics for a budget against a list of
 * historical transactions.
 *
 * ### How it works
 *
 * 1. The budget's **active window** is derived from `budget.period` and
 *    `budget.periodStart` (normalised to 00:00 UTC for day-level periods).
 * 2. Only transactions whose `createdAt` falls within the active window are
 *    counted — earlier or future entries are ignored.
 * 3. Counted transactions are **aggregated per asset** (by `Transaction.asset`)
 *    so multiple currencies can be tracked independently.
 * 4. For each asset, the budget's `limitAmount` is attributed as that asset's
 *    cap, and `spent / limit` yields the utilization.
 * 5. Overall totals combine spending across every asset.
 *
 * When no transaction falls within the active window (or the transaction list
 * is empty), all spending figures resolve to `"0"` and utilization to `0`.
 *
 * All arithmetic uses **string / BigInt integer math** and comparisons are
 * strict, so percentages and divisions are computed safely with no
 * floating-point or divide-by-zero hazards.
 *
 * @param budget         The budget whose active limit is being analyzed.
 * @param transactions   Historical transactions to aggregate.
 * @returns              A {@link BudgetUtilizationResult} with spending stats.
 */
export function calculateUtilization(
  budget: Budget,
  transactions: Transaction[],
): BudgetUtilizationResult {
  const totalLimit = budget.limitAmount;

  const { start: windowStart, end: windowEnd } = getWindow(budget.period, budget.periodStart);

  const active = transactions.filter((tx) => {
    const t = new Date(tx.createdAt).getTime();
    return t >= windowStart.getTime() && t < windowEnd.getTime();
  });

  // Aggregate spent amounts by asset, preserving first-seen order.
  const spentByAsset = new Map<string, DecimalString>();
  for (const tx of active) {
    const key = tx.asset;
    spentByAsset.set(key, decAdd(spentByAsset.get(key) ?? '0', tx.amount));
  }

  const assets: AssetUtilization[] = [];
  let totalSpent: DecimalString = '0';

  for (const [asset, spent] of spentByAsset) {
    totalSpent = decAdd(totalSpent, spent);

    const remaining = decSub(totalLimit, spent);
    const isOverBudget = decGtZero(spent) && decCmp(spent, totalLimit) === 1;

    const utilizationPercentage = utilizationPercent(spent, totalLimit);

    assets.push({
      asset,
      totalLimit,
      spentAmount: spent,
      remainingAmount: remaining,
      utilizationPercentage,
      isOverBudget,
    });
  }

  const overallRemaining = decSub(totalLimit, totalSpent);
  const overallOver = decGtZero(totalSpent) && decCmp(totalSpent, totalLimit) === 1;

  const overallUtilization = utilizationPercent(totalSpent, totalLimit);

  return {
    totalLimit,
    spentAmount: totalSpent,
    remainingAmount: overallRemaining,
    utilizationPercentage: overallUtilization,
    isOverBudget: overallOver,
    assets,
  };
}
