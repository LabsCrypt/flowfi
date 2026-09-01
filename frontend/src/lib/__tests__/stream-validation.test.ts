/**
 * stream-validation.test.ts
 *
 * Shared test suite for stream-creation validation logic.
 * This verifies the acceptance criteria from the audit issue:
 *   "All three entry points enforce identical validation rules,
 *    verified by a shared test suite run against each."
 *
 * The tests exercise the canonical `validateStreamForm` function that
 * is now the single source of truth for all three entry points:
 *   1. StreamCreationWizard (modal)
 *   2. CreateStreamContent (full-page)
 *   3. DashboardView inline settings form
 */

import { describe, it, expect } from "vitest";
import {
  validateStreamForm,
  validateRecipient,
  validateToken,
  validateAmount,
  validateDuration,
  type StreamFormData,
} from "@/lib/stream-validation";

// ─── Test data ────────────────────────────────────────────────────────────────

// Valid 56-char Stellar public key (starts with G, 55 Base32 chars from A-Z2-7)
const VALID_KEY = "GG32XLQSZXFBY6W3FNDRBAUNN4UXGA3P3M6DLKU5BU3RQ2UFBVSERB5K";
const INVALID_KEY_SHORT = "GABCDEFGH";
const INVALID_KEY_LOWERCASE = "gg32xlqszxfby6w3fndrbaunn4uxga3p3m6dlku5bu3rq2ufbvserb5k";
const INVALID_KEY_WRONG_PREFIX = "SG32XLQSZXFBY6W3FNDRBAUNN4UXGA3P3M6DLKU5BU3RQ2UFBVSERB5K";

const VALID_FORM: StreamFormData = {
  recipient: VALID_KEY,
  token: "USDC",
  amount: "100",
  duration: "30",
  durationUnit: "days",
};

// ─── validateRecipient ────────────────────────────────────────────────────────

describe("validateRecipient", () => {
  it("accepts a valid Stellar public key", () => {
    expect(validateRecipient(VALID_KEY)).toBeNull();
  });

  it("accepts a key with leading/trailing whitespace", () => {
    expect(validateRecipient(`  ${VALID_KEY}  `)).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(validateRecipient("")).toBe("Recipient address is required");
  });

  it("rejects whitespace-only string", () => {
    expect(validateRecipient("   ")).toBe("Recipient address is required");
  });

  it("rejects a short key", () => {
    expect(validateRecipient(INVALID_KEY_SHORT)).toBe(
      "Invalid Stellar public key format",
    );
  });

  it("rejects a lowercase key", () => {
    expect(validateRecipient(INVALID_KEY_LOWERCASE)).toBe(
      "Invalid Stellar public key format",
    );
  });

  it("rejects a key with wrong prefix (secret key)", () => {
    expect(validateRecipient(INVALID_KEY_WRONG_PREFIX)).toBe(
      "Invalid Stellar public key format",
    );
  });

  it("rejects an arbitrary string", () => {
    expect(validateRecipient("not-a-key")).toBe(
      "Invalid Stellar public key format",
    );
  });
});

// ─── validateToken ────────────────────────────────────────────────────────────

describe("validateToken", () => {
  it("accepts USDC", () => {
    expect(validateToken("USDC")).toBeNull();
  });

  it("accepts XLM", () => {
    expect(validateToken("XLM")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateToken("")).toBe("Please select a token");
  });

  it("rejects whitespace-only string", () => {
    expect(validateToken("   ")).toBe("Please select a token");
  });
});

// ─── validateAmount ───────────────────────────────────────────────────────────

describe("validateAmount", () => {
  it("accepts a valid positive integer", () => {
    expect(validateAmount("100")).toBeNull();
  });

  it("accepts a valid decimal", () => {
    expect(validateAmount("0.5")).toBeNull();
  });

  it("accepts maximum precision (7 decimal places)", () => {
    expect(validateAmount("1.1234567")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateAmount("")).toBe("Amount is required");
  });

  it("rejects zero", () => {
    expect(validateAmount("0")).toBe("Amount must be a positive number");
  });

  it("rejects negative amount", () => {
    expect(validateAmount("-5")).not.toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(validateAmount("abc")).not.toBeNull();
  });

  it("rejects too many decimal places (>7)", () => {
    expect(validateAmount("1.12345678")).toBe(
      "Amount exceeds maximum precision (7 decimal places)",
    );
  });

  // ── Wallet balance checks ───────────────────────────────────────────────

  it("passes when amount is within wallet balance", () => {
    expect(validateAmount("50", "100")).toBeNull();
  });

  it("passes when amount equals wallet balance exactly", () => {
    expect(validateAmount("100", "100")).toBeNull();
  });

  it("rejects when amount exceeds wallet balance", () => {
    expect(validateAmount("200", "100")).toBe(
      "Amount exceeds wallet balance",
    );
  });

  it("skips balance check when walletBalance is null", () => {
    expect(validateAmount("999999", null)).toBeNull();
  });

  it("skips balance check when walletBalance is undefined", () => {
    expect(validateAmount("999999", undefined)).toBeNull();
  });
});

// ─── validateDuration ─────────────────────────────────────────────────────────

describe("validateDuration", () => {
  it("accepts a positive integer", () => {
    expect(validateDuration("30")).toBeNull();
  });

  it("accepts a decimal", () => {
    expect(validateDuration("0.5")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateDuration("")).toBe("Duration is required");
  });

  it("rejects zero", () => {
    expect(validateDuration("0")).toBe(
      "Duration must be a positive number",
    );
  });

  it("rejects negative number", () => {
    expect(validateDuration("-10")).toBe(
      "Duration must be a positive number",
    );
  });

  it("rejects non-numeric string", () => {
    expect(validateDuration("abc")).toBe(
      "Duration must be a positive number",
    );
  });
});

// ─── validateStreamForm (composite) ───────────────────────────────────────────

describe("validateStreamForm", () => {
  describe("full-form mode (no step)", () => {
    it("returns no errors for a fully valid form", () => {
      expect(validateStreamForm(VALID_FORM)).toEqual({});
    });

    it("returns errors for every invalid field at once", () => {
      const badForm: StreamFormData = {
        recipient: "",
        token: "",
        amount: "",
        duration: "",
        durationUnit: "days",
      };
      const errors = validateStreamForm(badForm);
      expect(errors.recipient).toBeDefined();
      expect(errors.token).toBeDefined();
      expect(errors.amount).toBeDefined();
      expect(errors.duration).toBeDefined();
    });

    it("validates recipient format", () => {
      const errors = validateStreamForm({
        ...VALID_FORM,
        recipient: "not-valid",
      });
      expect(errors.recipient).toBe("Invalid Stellar public key format");
    });

    it("checks wallet balance when provided", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, amount: "1000" },
        { walletBalance: "500" },
      );
      expect(errors.amount).toBe("Amount exceeds wallet balance");
    });
  });

  describe("step mode (wizard)", () => {
    it("step 1 (template): no field validation", () => {
      const badForm: StreamFormData = {
        recipient: "",
        token: "",
        amount: "",
        duration: "",
        durationUnit: "days",
      };
      expect(validateStreamForm(badForm, { step: 1 })).toEqual({});
    });

    it("step 2 (recipient): only validates recipient", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, recipient: "" },
        { step: 2 },
      );
      expect(errors.recipient).toBeDefined();
      expect(errors.amount).toBeUndefined();
      expect(errors.token).toBeUndefined();
      expect(errors.duration).toBeUndefined();
    });

    it("step 3 (token): only validates token", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, token: "" },
        { step: 3 },
      );
      expect(errors.token).toBeDefined();
      expect(errors.recipient).toBeUndefined();
    });

    it("step 4 (amount): validates amount and balance", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, amount: "1000" },
        { step: 4, walletBalance: "500" },
      );
      expect(errors.amount).toBe("Amount exceeds wallet balance");
      expect(errors.recipient).toBeUndefined();
    });

    it("step 5 (duration): only validates duration", () => {
      const errors = validateStreamForm(
        { ...VALID_FORM, duration: "" },
        { step: 5 },
      );
      expect(errors.duration).toBeDefined();
      expect(errors.amount).toBeUndefined();
    });
  });

  // ─── Acceptance criteria: identical rules across entry points ───────────

  describe("acceptance criteria: consistent validation across entry points", () => {
    /**
     * Scenario: All three entry points must reject an invalid recipient.
     * Before this fix, create-stream-content.tsx did NOT check recipient
     * format on form submission.
     */
    it("rejects invalid recipient format (Functional Edge Case #3)", () => {
      const data: StreamFormData = {
        ...VALID_FORM,
        recipient: "invalid-address",
      };
      // Full-form mode (page + dashboard)
      expect(validateStreamForm(data).recipient).toBe(
        "Invalid Stellar public key format",
      );
      // Step mode (wizard step 2)
      expect(validateStreamForm(data, { step: 2 }).recipient).toBe(
        "Invalid Stellar public key format",
      );
    });

    /**
     * Scenario: All three entry points must reject amounts exceeding
     * wallet balance. Before this fix, only the wizard checked balance.
     */
    it("rejects amount exceeding wallet balance (consistency gap)", () => {
      const data: StreamFormData = { ...VALID_FORM, amount: "5000" };
      const opts = { walletBalance: "1000" };
      // Full-form mode
      expect(validateStreamForm(data, opts).amount).toBe(
        "Amount exceeds wallet balance",
      );
      // Step mode
      expect(validateStreamForm(data, { step: 4, ...opts }).amount).toBe(
        "Amount exceeds wallet balance",
      );
    });

    /**
     * Scenario: All three entry points must reject amounts with too many
     * decimal places.
     */
    it("rejects excessive precision uniformly", () => {
      const data: StreamFormData = {
        ...VALID_FORM,
        amount: "1.12345678",
      };
      expect(validateStreamForm(data).amount).toBe(
        "Amount exceeds maximum precision (7 decimal places)",
      );
    });
  });
});
