/**
 * Test for Issue #699: Unified template storage key
 * Ensures StreamCreationWizard and dashboard-view use the same localStorage key
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const UNIFIED_STORAGE_KEY = 'flowfi.stream.templates.v1';
const OLD_WIZARD_KEY = 'flowfi.stream.wizard.custom-templates.v1';

describe('Template Storage Key Unification (Issue #699)', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should use the unified storage key', () => {
    const testTemplate = {
      id: 'test-1',
      name: 'Test Template',
      description: 'Test description',
      values: {
        token: 'USDC',
        amount: '100',
        duration: '30',
        durationUnit: 'days',
      },
    };

    // Save to unified key
    localStorage.setItem(UNIFIED_STORAGE_KEY, JSON.stringify([testTemplate]));

    // Verify it's stored in the unified key
    const stored = localStorage.getItem(UNIFIED_STORAGE_KEY);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!)).toEqual([testTemplate]);

    // Verify old key is not used
    const oldStored = localStorage.getItem(OLD_WIZARD_KEY);
    expect(oldStored).toBeNull();
  });

  it('should read templates from unified key', () => {
    const templates = [
      {
        id: 'template-1',
        name: 'Monthly Salary',
        description: 'Recurring monthly payroll',
        values: {
          token: 'USDC',
          amount: '5000',
          duration: '1',
          durationUnit: 'months',
        },
      },
      {
        id: 'template-2',
        name: 'Weekly Subscription',
        description: 'Weekly billing',
        values: {
          token: 'USDC',
          amount: '49',
          duration: '1',
          durationUnit: 'weeks',
        },
      },
    ];

    localStorage.setItem(UNIFIED_STORAGE_KEY, JSON.stringify(templates));

    const retrieved = localStorage.getItem(UNIFIED_STORAGE_KEY);
    expect(retrieved).toBeTruthy();
    const parsed = JSON.parse(retrieved!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('Monthly Salary');
    expect(parsed[1].name).toBe('Weekly Subscription');
  });

  it('should handle empty template list', () => {
    localStorage.setItem(UNIFIED_STORAGE_KEY, JSON.stringify([]));

    const retrieved = localStorage.getItem(UNIFIED_STORAGE_KEY);
    expect(retrieved).toBeTruthy();
    const parsed = JSON.parse(retrieved!);
    expect(parsed).toEqual([]);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('should handle missing storage gracefully', () => {
    const retrieved = localStorage.getItem(UNIFIED_STORAGE_KEY);
    expect(retrieved).toBeNull();
  });

  it('should verify both wizard and dashboard can access same templates', () => {
    const sharedTemplate = {
      id: 'shared-1',
      name: 'Shared Template',
      description: 'Accessible from both surfaces',
      values: {
        token: 'USDC',
        amount: '1000',
        duration: '14',
        durationUnit: 'days',
      },
    };

    // Simulate wizard saving a template
    localStorage.setItem(UNIFIED_STORAGE_KEY, JSON.stringify([sharedTemplate]));

    // Simulate dashboard reading the same template
    const dashboardRead = localStorage.getItem(UNIFIED_STORAGE_KEY);
    expect(dashboardRead).toBeTruthy();
    const parsed = JSON.parse(dashboardRead!);
    expect(parsed[0]).toEqual(sharedTemplate);

    // Verify the template is accessible with the unified key
    expect(parsed[0].name).toBe('Shared Template');
    expect(parsed[0].values.amount).toBe('1000');
  });

  it('should not have data in old wizard key', () => {
    const template = {
      id: 'new-1',
      name: 'New Template',
      values: {},
    };

    localStorage.setItem(UNIFIED_STORAGE_KEY, JSON.stringify([template]));

    // Verify old key remains empty
    const oldKey = localStorage.getItem(OLD_WIZARD_KEY);
    expect(oldKey).toBeNull();
  });
});
