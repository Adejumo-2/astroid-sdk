import { describe, expect, it } from 'vitest';

import type { Budget, Transaction } from '@astroid/types';

import { calculateUtilization } from './utils.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const USD_ASSET = 'USDC';
const XLM_ASSET = 'XLM';

function makeBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: 'budget-1',
    organizationId: 'org-1',
    name: 'Test Budget',
    currency: USD_ASSET,
    limitAmount: '100',
    spent: '0',
    remaining: '100',
    period: 'DAILY',
    periodStart: '2025-06-15T00:00:00.000Z',
    rollover: false,
    enabled: true,
    createdAt: '2025-06-15T00:00:00.000Z',
    updatedAt: '2025-06-15T00:00:00.000Z',
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    organizationId: 'org-1',
    walletId: 'wallet-1',
    asset: USD_ASSET,
    amount: '10',
    status: 'COMPLETED',
    riskScore: 0,
    riskBand: 'LOW',
    requiresApproval: false,
    recipientAddress: 'GABC...',
    confirmationCount: 1,
    metadata: {},
    createdAt: '2025-06-15T12:00:00.000Z',
    updatedAt: '2025-06-15T12:00:00.000Z',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('calculateUtilization', () => {
  it('returns zeroed stats when there is no matching transaction history', () => {
    const budget = makeBudget({ limitAmount: '100' });
    const result = calculateUtilization(budget, []);

    expect(result.totalLimit).toBe('100');
    expect(result.spentAmount).toBe('0');
    expect(result.remainingAmount).toBe('100');
    expect(result.utilizationPercentage).toBe(0);
    expect(result.isOverBudget).toBe(false);
    expect(result.assets).toEqual([]);
  });

  it('returns zeroed stats when transactions fall outside the active window', () => {
    const budget = makeBudget({ limitAmount: '100' });
    const tx = makeTx({ createdAt: '2025-01-01T00:00:00.000Z' });

    const result = calculateUtilization(budget, [tx]);

    expect(result.spentAmount).toBe('0');
    expect(result.remainingAmount).toBe('100');
    expect(result.utilizationPercentage).toBe(0);
    expect(result.isOverBudget).toBe(false);
  });

  it('aggregates matching transactions within the window', () => {
    const budget = makeBudget({ limitAmount: '100' });
    const transactions = [makeTx({ amount: '25.5' }), makeTx({ amount: '10', id: 'tx-2' })];

    const result = calculateUtilization(budget, transactions);

    expect(result.spentAmount).toBe('35.5');
    expect(result.remainingAmount).toBe('64.5');
    expect(result.isOverBudget).toBe(false);
    expect(result.assets[0]?.spentAmount).toBe('35.5');
  });

  it('flags when aggregate spending exceeds the limit', () => {
    const budget = makeBudget({ limitAmount: '50' });
    const transactions = [makeTx({ amount: '30' }), makeTx({ amount: '25', id: 'tx-2' })];

    const result = calculateUtilization(budget, transactions);

    expect(result.spentAmount).toBe('55');
    expect(result.remainingAmount).toBe('0');
    expect(result.isOverBudget).toBe(true);
  });

  it('computes the exact utilization percentage', () => {
    const budget = makeBudget({ limitAmount: '100' });
    const result = calculateUtilization(budget, [makeTx({ amount: '50' })]);

    expect(result.utilizationPercentage).toBe(50);
  });

  it('computes fractional utilization without floating-point drift', () => {
    const budget = makeBudget({ limitAmount: '100' });
    const result = calculateUtilization(budget, [makeTx({ amount: '33.333333' })]);

    expect(result.utilizationPercentage).toBeCloseTo(33.3333, 4);
    expect(result.utilizationPercentage).toBeGreaterThan(0);
  });

  it('returns zero utilization when the limit is zero', () => {
    const budget = makeBudget({ limitAmount: '0' });
    const result = calculateUtilization(budget, [makeTx({ amount: '5' })]);

    expect(result.totalLimit).toBe('0');
    expect(result.utilizationPercentage).toBe(0);
    expect(result.isOverBudget).toBe(true);
    expect(result.remainingAmount).toBe('0');
  });

  it('normalises big decimal totals for the whole window', () => {
    const budget = makeBudget({ limitAmount: '1000' });
    const result = calculateUtilization(budget, [
      makeTx({ amount: '1.10' }),
      makeTx({ amount: '2.20', id: 'tx-2' }),
    ]);

    expect(result.spentAmount).toBe('3.3');
    expect(result.utilizationPercentage).toBeCloseTo(0.33, 2);
  });

  describe('multiple assets', () => {
    it('computes totals separately for each asset', () => {
      const budget = makeBudget({ limitAmount: '100' });
      const transactions = [
        makeTx({ asset: USD_ASSET, amount: '40' }),
        makeTx({ asset: USD_ASSET, amount: '10', id: 'tx-2' }),
        makeTx({ asset: XLM_ASSET, amount: '30', id: 'tx-3' }),
      ];

      const result = calculateUtilization(budget, transactions);

      expect(result.assets).toHaveLength(2);

      const usdc = result.assets.find((a) => a.asset === USD_ASSET);
      const xlm = result.assets.find((a) => a.asset === XLM_ASSET);

      expect(usdc?.spentAmount).toBe('50');
      expect(usdc?.remainingAmount).toBe('50');
      expect(usdc?.isOverBudget).toBe(false);
      expect(usdc?.utilizationPercentage).toBe(50);

      expect(xlm?.spentAmount).toBe('30');
      expect(xlm?.remainingAmount).toBe('70');
      expect(xlm?.isOverBudget).toBe(false);
      expect(xlm?.utilizationPercentage).toBe(30);

      // Overall sums every asset.
      expect(result.spentAmount).toBe('80');
      expect(result.remainingAmount).toBe('20');
      expect(result.isOverBudget).toBe(false);
    });

    it('flags an individual asset as over budget independently', () => {
      const budget = makeBudget({ limitAmount: '100' });
      const transactions = [
        makeTx({ asset: XLM_ASSET, amount: '120', id: 'tx-3' }),
        makeTx({ asset: USD_ASSET, amount: '10', id: 'tx-4' }),
      ];

      const result = calculateUtilization(budget, transactions);

      const xlm = result.assets.find((a) => a.asset === XLM_ASSET);
      const usdc = result.assets.find((a) => a.asset === USD_ASSET);

      expect(xlm?.isOverBudget).toBe(true);
      expect(xlm?.remainingAmount).toBe('0');
      expect(usdc?.isOverBudget).toBe(false);

      expect(result.isOverBudget).toBe(true);
    });
  });
});
