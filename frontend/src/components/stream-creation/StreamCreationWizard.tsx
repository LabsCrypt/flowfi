"use client";
import React, { useState } from "react";
import { Stepper } from "../ui/Stepper";
import { Button } from "../ui/Button";
import { RecipientStep } from "./RecipientStep";
import { TokenStep } from "./TokenStep";
import { AmountStep } from "./AmountStep";
import { ScheduleStep } from "./ScheduleStep";
import { TemplateStep, type StreamTemplate } from "./TemplateStep";
import { fetchTokenBalanceDisplay } from "@/lib/soroban";
import { isValidStellarPublicKey } from "@/lib/stellar";
import { hasValidPrecision } from "@/utils/amount";
import toast from "react-hot-toast";

export interface StreamFormData {
  recipient: string;
  token: string;
  amount: string;
  duration: string;
  durationUnit: "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";
  descriptionTag?: string;
}

interface StreamCreationWizardProps {
  onClose: () => void;
  onSubmit: (data: StreamFormData) => Promise<void>;
  walletPublicKey?: string;
}

const CUSTOM_TEMPLATE_STORAGE_KEY = "flowfi.stream.wizard.custom-templates.v1";

const BUILT_IN_TEMPLATES: StreamTemplate[] = [
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

const STEPS = ["Template", "Recipient", "Token", "Amount", "Schedule"];

export const StreamCreationWizard: React.FC<StreamCreationWizardProps> = ({
  onClose,
  onSubmit,
  walletPublicKey,
}) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [customTemplates, setCustomTemplates] = useState<StreamTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("monthly-salary");
  const [customTemplateName, setCustomTemplateName] = useState("");
  const [templateSaveMessage, setTemplateSaveMessage] = useState<string | null>(null);
  const [formData, setFormData] = useState<StreamFormData>({
    recipient: "",
    token: "USDC",
    amount: "5000",
    duration: "1",
    durationUnit: "months",
    descriptionTag: "salary",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof StreamFormData, string>>>({});
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false);
  const [walletBalanceError, setWalletBalanceError] = useState<string | null>(null);

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(CUSTOM_TEMPLATE_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return;
      const sanitized = parsed
        .filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
        .map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description || "Saved custom template",
          values: item.values || {},
        } as StreamTemplate));
      setCustomTemplates(sanitized);
    } catch {
      setCustomTemplates([]);
    }
  }, []);

  React.useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_TEMPLATE_STORAGE_KEY, JSON.stringify(customTemplates));
    } catch {
      // ignore localStorage write errors
    }
  }, [customTemplates]);

  React.useEffect(() => {
    if (!walletPublicKey || !formData.token) {
      setWalletBalance(null);
      setWalletBalanceError(null);
      setWalletBalanceLoading(false);
      return;
    }

    let cancelled = false;
    setWalletBalanceLoading(true);
    setWalletBalanceError(null);

    fetchTokenBalanceDisplay(walletPublicKey, formData.token)
      .then((balance) => {
        if (cancelled) return;
        setWalletBalance(balance);
      })
      .catch(() => {
        if (cancelled) return;
        setWalletBalance(null);
        setWalletBalanceError("Unable to fetch wallet balance right now.");
      })
      .finally(() => {
        if (cancelled) return;
        setWalletBalanceLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletPublicKey, formData.token]);

  const updateFormData = (updates: Partial<StreamFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
    // Clear errors for updated fields
    setErrors((prev) => {
      const newErrors = { ...prev };
      Object.keys(updates).forEach((key) => {
        delete newErrors[key as keyof StreamFormData];
      });
      return newErrors;
    });
  };

  const allTemplates = React.useMemo(
    () => [...BUILT_IN_TEMPLATES, ...customTemplates],
    [customTemplates]
  );

  const applyTemplate = (templateId: string) => {
    const template = allTemplates.find((item) => item.id === templateId);
    if (!template) return;
    setSelectedTemplateId(templateId);
    setTemplateSaveMessage(`Applied template "${template.name}". You can still edit every field.`);
    updateFormData({
      token: template.values.token ?? formData.token,
      amount: template.values.amount ?? formData.amount,
      duration: template.values.duration ?? formData.duration,
      durationUnit: template.values.durationUnit ?? formData.durationUnit,
      descriptionTag: template.values.descriptionTag ?? formData.descriptionTag,
    });
  };

  const saveCurrentAsCustomTemplate = () => {
    const cleanedName = customTemplateName.trim();
    if (!cleanedName) {
      setTemplateSaveMessage("Enter a template name first.");
      return;
    }

    if (!formData.amount || !formData.duration || !formData.token) {
      setTemplateSaveMessage("Set amount, duration, and token before saving a custom template.");
      return;
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
    setCustomTemplateName("");
    setTemplateSaveMessage(`Saved custom template "${cleanedName}".`);
    setSelectedTemplateId(newTemplate.id);
  };

  const validateStep = (step: number): boolean => {
    const newErrors: Partial<Record<keyof StreamFormData, string>> = {};

    switch (step) {
      case 1: // Template
        break;
      case 2: // Recipient
        if (!formData.recipient.trim()) {
          newErrors.recipient = "Recipient address is required";
        } else if (!isValidStellarPublicKey(formData.recipient.trim())) {
          newErrors.recipient = "Invalid Stellar public key format";
        }
        break;
      case 3: // Token
        if (!formData.token) {
          newErrors.token = "Please select a token";
        }
        break;
      case 4: // Amount
        if (!formData.amount.trim()) {
          newErrors.amount = "Amount is required";
        } else {
          const amount = parseFloat(formData.amount);
          if (isNaN(amount) || amount <= 0) {
            newErrors.amount = "Amount must be a positive number";
          } else if (!hasValidPrecision(formData.amount, 7)) {
            newErrors.amount = "Maximum 7 decimal places allowed";
          } else if (walletBalance) {
            const available = parseFloat(walletBalance);
            if (!isNaN(available) && amount > available) {
              newErrors.amount = "Amount exceeds wallet balance";
            }
          }
        }
        break;
      case 5: // Schedule
        if (!formData.duration.trim()) {
          newErrors.duration = "Duration is required";
        } else {
          const duration = parseFloat(formData.duration);
          if (isNaN(duration) || duration <= 0) {
            newErrors.duration = "Duration must be a positive number";
          }
        }
        break;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (validateStep(currentStep)) {
      if (currentStep < STEPS.length) {
        setCurrentStep(currentStep + 1);
        // Scroll to top when moving to next step
        const modal = document.querySelector('.glass-card');
        if (modal) {
          modal.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
    } else {
      // Scroll to first error if validation fails
      const firstError = document.querySelector('[role="alert"]');
      if (firstError) {
        firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
      // Scroll to top when going back
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleSubmit = async () => {
    if (validateStep(currentStep)) {
      setIsSubmitting(true);
      try {
        await onSubmit(formData);
        toast.success("Stream created successfully!");
      } catch (error) {
        console.error("Failed to create stream:", error);
        toast.error("Failed to create stream. Please try again.");
        setIsSubmitting(false);
      }
    } else {
      // Scroll to first error if validation fails
      const firstError = document.querySelector('[role="alert"]');
      if (firstError) {
        firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <TemplateStep
            templates={allTemplates}
            selectedTemplateId={selectedTemplateId}
            onSelectTemplate={applyTemplate}
            customTemplateName={customTemplateName}
            onCustomTemplateNameChange={setCustomTemplateName}
            onSaveCustomTemplate={saveCurrentAsCustomTemplate}
            saveDisabled={isSubmitting}
            saveMessage={templateSaveMessage}
          />
        );
      case 2:
        return (
          <RecipientStep
            value={formData.recipient}
            onChange={(value) => updateFormData({ recipient: value })}
            error={errors.recipient}
          />
        );
      case 3:
        return (
          <TokenStep
            value={formData.token}
            onChange={(value) => updateFormData({ token: value })}
            error={errors.token}
          />
        );
      case 4:
        return (
          <AmountStep
            value={formData.amount}
            onChange={(value) => updateFormData({ amount: value })}
            error={errors.amount}
            token={formData.token}
            availableBalance={walletBalance}
            isBalanceLoading={walletBalanceLoading}
            balanceError={walletBalanceError}
            onSetMax={() => {
              if (!walletBalance) return;
              updateFormData({ amount: walletBalance });
            }}
          />
        );
      case 5:
        return (
          <ScheduleStep
            duration={formData.duration}
            durationUnit={formData.durationUnit}
            onDurationChange={(value) => updateFormData({ duration: value })}
            onUnitChange={(value) => updateFormData({ durationUnit: value })}
            error={errors.duration}
            amount={formData.amount}
            token={formData.token}
          />
        );
      default:
        return null;
    }
  };

  // Handle Escape key to close
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        // Close on backdrop click
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="glass-card relative z-10 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-glass-border p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold">Create Payment Stream</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <Stepper steps={STEPS} currentStep={currentStep} />

        <div className="my-8 min-h-[300px]">
          <div className="mb-6 flex items-center justify-between">
            <div className="text-sm text-slate-400">
              Step {currentStep} of {STEPS.length}
            </div>
            <div className="text-xs text-slate-500">
              {Math.round((currentStep / STEPS.length) * 100)}% complete
            </div>
          </div>
          {formData.descriptionTag && (
            <div className="mb-4">
              <span className="inline-flex rounded-full border border-accent/40 px-3 py-1 text-xs font-semibold text-accent">
                Tag: {formData.descriptionTag}
              </span>
            </div>
          )}
          {renderStepContent()}
        </div>

        <div className="flex justify-between gap-4 pt-6 border-t border-glass-border">
          <div>
            {currentStep > 1 && (
              <Button variant="outline" onClick={handleBack}>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-4">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {currentStep < STEPS.length ? (
              <Button onClick={handleNext}>
                Next
                <svg className="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Button>
            ) : (
              <Button onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Creating...
                  </>
                ) : (
                  "Create Stream"
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
