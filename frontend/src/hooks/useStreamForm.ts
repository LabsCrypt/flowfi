"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  validateStreamForm,
  type StreamFormData,
  type StreamFormErrors,
} from "@/lib/stream-validation";
import { fetchTokenBalanceDisplay } from "@/lib/soroban";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { StreamFormData, StreamFormErrors };

export interface StreamTemplate {
  id: string;
  name: string;
  description: string;
  values: Partial<StreamFormData>;
  builtIn?: boolean;
}

export interface UseStreamFormOptions {
  /** Wallet public key for balance lookups */
  walletPublicKey?: string;
  /** Initial form data (e.g. from a restored draft or URL params) */
  initialData?: Partial<StreamFormData>;
  /**
   * Storage key for custom templates.
   * Defaults to the standard "flowfi.stream.templates.v1".
   */
  templateStorageKey?: string;
  /** Whether to auto-persist drafts to sessionStorage */
  enableDraftPersistence?: boolean;
  /** Draft storage key. Defaults to "flowfi.create-stream.draft.v1" */
  draftStorageKey?: string;
}

export interface UseStreamFormReturn {
  /** Current form values */
  formData: StreamFormData;
  /** Per-field validation errors */
  errors: StreamFormErrors;
  /** Update one or more form fields */
  updateFormData: (updates: Partial<StreamFormData>) => void;
  /** Reset form to default values */
  resetForm: () => void;
  /** Validate a single step (wizard-mode); returns true if valid */
  validateStep: (step: number) => boolean;
  /** Validate the entire form at once; returns true if valid */
  validateAll: () => boolean;
  /** Current wallet balance for the selected token (display string) */
  walletBalance: string | null;
  /** Whether the balance is currently loading */
  walletBalanceLoading: boolean;
  /** Error message if the balance fetch failed */
  walletBalanceError: string | null;
  /** Set the form amount to the full wallet balance */
  setMaxAmount: () => void;
  // ── Template helpers ────────────────────────────────────────────────────
  /** All available templates (built-in + custom) */
  allTemplates: StreamTemplate[];
  /** Custom templates only */
  customTemplates: StreamTemplate[];
  /** Currently selected template ID */
  selectedTemplateId: string | null;
  /** Apply a template by ID */
  applyTemplate: (templateId: string) => string | null;
  /** Save current form values as a custom template */
  saveCustomTemplate: (name: string) => string | null;
  /** Delete a custom template by ID */
  deleteCustomTemplate: (templateId: string) => void;
  // ── Draft helpers ───────────────────────────────────────────────────────
  /** Whether a draft was restored on mount */
  hasDraft: boolean;
  /** Discard the current draft */
  discardDraft: () => void;
  /** Timestamp of the restored draft */
  draftSavedAt: number | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATE_STORAGE_KEY = "flowfi.stream.templates.v1";
const DEFAULT_DRAFT_STORAGE_KEY = "flowfi.create-stream.draft.v1";

export const DEFAULT_FORM_DATA: StreamFormData = {
  recipient: "",
  token: "USDC",
  amount: "",
  duration: "",
  durationUnit: "days",
  descriptionTag: "",
};

export const BUILT_IN_TEMPLATES: StreamTemplate[] = [
  {
    id: "monthly-salary",
    name: "Monthly Salary",
    description: "Recurring monthly payroll stream",
    builtIn: true,
    values: {
      token: "USDC",
      amount: "5000",
      duration: "1",
      durationUnit: "months",
      descriptionTag: "salary",
    },
  },
  {
    id: "weekly-subscription",
    name: "Weekly Subscription",
    description: "Weekly recurring subscription billing",
    builtIn: true,
    values: {
      token: "USDC",
      amount: "49",
      duration: "1",
      durationUnit: "weeks",
      descriptionTag: "subscription",
    },
  },
  {
    id: "one-time-grant",
    name: "One-time Grant",
    description: "Short fixed-duration grant payout",
    builtIn: true,
    values: {
      token: "USDC",
      amount: "1000",
      duration: "14",
      durationUnit: "days",
      descriptionTag: "grant",
    },
  },
  {
    id: "custom",
    name: "Custom",
    description: "Start with blank defaults",
    builtIn: true,
    values: {
      token: "USDC",
      amount: "",
      duration: "",
      durationUnit: "days",
      descriptionTag: "custom",
    },
  },
];

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface DraftPayload {
  recipient: string;
  token: string;
  amount: string;
  duration: string;
  durationUnit?: StreamFormData["durationUnit"];
  descriptionTag?: string;
  savedAt: number;
}

function loadDraft(key: string): DraftPayload | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftPayload;
    if (
      parsed &&
      typeof parsed.recipient === "string" &&
      typeof parsed.amount === "string" &&
      (parsed.recipient.trim() !== "" || parsed.amount.trim() !== "")
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveDraft(key: string, data: StreamFormData): void {
  try {
    if (typeof window === "undefined") return;
    // Don't save pristine forms (require user to have typed a recipient or amount)
    if (
      data.recipient.trim() === "" &&
      data.amount.trim() === ""
    ) {
      return;
    }
    const payload: DraftPayload = {
      recipient: data.recipient,
      token: data.token,
      amount: data.amount,
      duration: data.duration,
      durationUnit: data.durationUnit,
      descriptionTag: data.descriptionTag,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // sessionStorage may be full or unavailable
  }
}

function clearDraft(key: string): void {
  try {
    if (typeof window === "undefined") return;
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function loadCustomTemplates(key: string): StreamTemplate[] {
  try {
    if (typeof window === "undefined") return [];
    const stored = localStorage.getItem(key);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item: Record<string, unknown>) =>
          item && typeof item.id === "string" && typeof item.name === "string",
      )
      .map(
        (item: Record<string, unknown>) =>
          ({
            id: item.id,
            name: item.name,
            description:
              (item.description as string) || "Saved custom template",
            values: (item.values as Partial<StreamFormData>) || {},
          }) as StreamTemplate,
      );
  } catch {
    return [];
  }
}

function persistCustomTemplates(key: string, items: StreamTemplate[]): void {
  try {
    if (typeof window === "undefined") return;
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // ignore
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useStreamForm(
  options: UseStreamFormOptions = {},
): UseStreamFormReturn {
  const {
    walletPublicKey,
    initialData,
    templateStorageKey = DEFAULT_TEMPLATE_STORAGE_KEY,
    enableDraftPersistence = false,
    draftStorageKey = DEFAULT_DRAFT_STORAGE_KEY,
  } = options;

  // ── Draft restoration ───────────────────────────────────────────────────
  const [restoredDraft] = useState<DraftPayload | null>(() => {
    if (!enableDraftPersistence) return null;
    return loadDraft(draftStorageKey);
  });

  const [draftDiscarded, setDraftDiscarded] = useState(false);
  const hasDraft = restoredDraft !== null && !draftDiscarded;
  const draftSavedAt = hasDraft ? restoredDraft!.savedAt : null;

  // ── Form state ──────────────────────────────────────────────────────────
  const [formData, setFormData] = useState<StreamFormData>(() => {
    const base = { ...DEFAULT_FORM_DATA };
    // Draft takes priority, then initialData
    if (restoredDraft && enableDraftPersistence) {
      return {
        ...base,
        recipient: restoredDraft.recipient,
        token: restoredDraft.token,
        amount: restoredDraft.amount,
        duration: restoredDraft.duration,
        durationUnit: restoredDraft.durationUnit ?? base.durationUnit,
        descriptionTag: restoredDraft.descriptionTag ?? base.descriptionTag,
      };
    }
    if (initialData) {
      return { ...base, ...initialData };
    }
    return base;
  });

  const [errors, setErrors] = useState<StreamFormErrors>({});

  // ── Wallet balance ──────────────────────────────────────────────────────
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false);
  const [walletBalanceError, setWalletBalanceError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    if (!walletPublicKey || !formData.token) {
      Promise.resolve().then(() => {
        if (!cancelled) {
          setWalletBalance(null);
          setWalletBalanceError(null);
          setWalletBalanceLoading(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    Promise.resolve().then(() => {
      if (!cancelled) {
        setWalletBalanceLoading(true);
        setWalletBalanceError(null);
      }
    });

    fetchTokenBalanceDisplay(walletPublicKey, formData.token)
      .then((balance) => {
        if (cancelled) return;
        setWalletBalance(balance);
      })
      .catch(() => {
        if (cancelled) return;
        setWalletBalance(null);
        setWalletBalanceError(
          "Unable to fetch wallet balance right now.",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setWalletBalanceLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletPublicKey, formData.token]);

  // ── Draft persistence ───────────────────────────────────────────────────
  useEffect(() => {
    if (!enableDraftPersistence) return;
    const timer = setTimeout(() => {
      saveDraft(draftStorageKey, formData);
    }, 500);
    return () => clearTimeout(timer);
  }, [formData, enableDraftPersistence, draftStorageKey]);

  // ── Template state ──────────────────────────────────────────────────────
  const [customTemplates, setCustomTemplates] = useState<StreamTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );

  // Hydrate from localStorage
  useEffect(() => {
    const timer = setTimeout(() => {
      setCustomTemplates(loadCustomTemplates(templateStorageKey));
    }, 0);
    return () => clearTimeout(timer);
  }, [templateStorageKey]);

  // Persist when changed
  useEffect(() => {
    persistCustomTemplates(templateStorageKey, customTemplates);
  }, [customTemplates, templateStorageKey]);

  const allTemplates = useMemo(
    () => [...BUILT_IN_TEMPLATES, ...customTemplates],
    [customTemplates],
  );

  // ── Form helpers ────────────────────────────────────────────────────────

  const updateFormData = useCallback(
    (updates: Partial<StreamFormData>) => {
      setFormData((prev) => ({ ...prev, ...updates }));
      // Clear errors for updated fields
      setErrors((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(updates)) {
          delete next[key as keyof StreamFormErrors];
        }
        return next;
      });
    },
    [],
  );

  const resetForm = useCallback(() => {
    setFormData({ ...DEFAULT_FORM_DATA });
    setErrors({});
    setSelectedTemplateId(null);
    if (enableDraftPersistence) {
      clearDraft(draftStorageKey);
    }
  }, [enableDraftPersistence, draftStorageKey]);

  const validateStep = useCallback(
    (step: number): boolean => {
      const newErrors = validateStreamForm(formData, {
        step,
        walletBalance,
      });
      setErrors(newErrors);
      return Object.keys(newErrors).length === 0;
    },
    [formData, walletBalance],
  );

  const validateAll = useCallback((): boolean => {
    const newErrors = validateStreamForm(formData, {
      walletBalance,
    });
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData, walletBalance]);

  const setMaxAmount = useCallback(() => {
    if (!walletBalance) return;
    updateFormData({ amount: walletBalance });
  }, [walletBalance, updateFormData]);

  // ── Template helpers ────────────────────────────────────────────────────

  const applyTemplate = useCallback(
    (templateId: string): string | null => {
      const template = allTemplates.find((t) => t.id === templateId);
      if (!template) return null;
      setSelectedTemplateId(templateId);
      updateFormData({
        token: template.values.token ?? formData.token,
        amount: template.values.amount ?? formData.amount,
        duration: template.values.duration ?? formData.duration,
        durationUnit: template.values.durationUnit ?? formData.durationUnit,
        descriptionTag:
          template.values.descriptionTag ?? formData.descriptionTag,
      });
      return `Applied template "${template.name}". You can still edit every field.`;
    },
    [allTemplates, formData, updateFormData],
  );

  const saveCustomTemplate = useCallback(
    (name: string): string | null => {
      const cleanedName = name.trim();
      if (!cleanedName) {
        return "Enter a template name first.";
      }
      if (!formData.amount || !formData.duration || !formData.token) {
        return "Set amount, duration, and token before saving a custom template.";
      }
      const newTemplate: StreamTemplate = {
        id: `custom-${Date.now()}`,
        name: cleanedName,
        description: formData.descriptionTag
          ? `Tag: ${formData.descriptionTag}`
          : "Saved custom template",
        values: {
          token: formData.token,
          amount: formData.amount,
          duration: formData.duration,
          durationUnit: formData.durationUnit,
          descriptionTag: formData.descriptionTag || "custom",
        },
      };
      setCustomTemplates((prev) => [newTemplate, ...prev]);
      setSelectedTemplateId(newTemplate.id);
      return null; // success (no error)
    },
    [formData],
  );

  const deleteCustomTemplate = useCallback(
    (templateId: string) => {
      setCustomTemplates((prev) => prev.filter((t) => t.id !== templateId));
      if (selectedTemplateId === templateId) {
        setSelectedTemplateId(null);
      }
    },
    [selectedTemplateId],
  );

  // ── Draft helpers ───────────────────────────────────────────────────────

  const discardDraft = useCallback(() => {
    clearDraft(draftStorageKey);
    setDraftDiscarded(true);
    setFormData({ ...DEFAULT_FORM_DATA });
  }, [draftStorageKey]);

  return {
    formData,
    errors,
    updateFormData,
    resetForm,
    validateStep,
    validateAll,
    walletBalance,
    walletBalanceLoading,
    walletBalanceError,
    setMaxAmount,
    allTemplates,
    customTemplates,
    selectedTemplateId,
    applyTemplate,
    saveCustomTemplate,
    deleteCustomTemplate,
    hasDraft,
    discardDraft,
    draftSavedAt,
  };
}
