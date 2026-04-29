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
import { TransactionTracker } from "../ui/TransactionTracker";
import toast from "react-hot-toast";
import { useRouter } from "next/navigation";

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
  
  // Tracking & Polling state (Issue #378)
  const [txHash, setTxHash] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [timeout, setTimeoutError] = useState(false);
  
  const router = useRouter();

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

  const startPolling = async (senderAddress: string) => {
    const startTime = Date.now();
    const TIMEOUT_MS = 30000; // 30 seconds
    const POLL_INTERVAL = 2000; // 2 seconds

    while (Date.now() - startTime < TIMEOUT_MS) {
      try {
        const response = await fetch(`/v1/streams?sender=${senderAddress}`);
        const streams = await response.json();
        
        // Assuming the latest stream is what we want
        if (streams && streams.length > 0) {
          // Found!
          const newStream = streams[0]; // Simplification
          toast.success("Stream indexed and confirmed!");
          router.push(`/app/streams/${newStream.streamId}`); // Updated path to match new structure
          return;
        }
      } catch (e) {
        console.warn("Polling error:", e);
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }

    // Timeout
    setTimeoutError(true);
  };

  const handleSubmit = async () => {
    if (validateStep(currentStep)) {
      setIsSubmitting(true);
      try {
        // Step 1: Submit transaction
        const result = (await onSubmit(formData)) as unknown as { txHash: string };
        const hash = result?.txHash;
        setTxHash(hash);
        
        // Step 2: Start Polling for Indexer
        setIsPolling(true);
        await startPolling(formData.recipient);
        
      } catch (error) {
        console.error("Failed to create stream:", error);
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
          {isPolling ? (
            <div className="flex flex-col items-center justify-center py-10">
              <h3 className="text-xl font-bold mb-8">
                {timeout ? "Confirmation Timeout" : "Waiting for confirmation..."}
              </h3>
              
              {!timeout ? (
                <>
                  <TransactionTracker 
                    steps={[
                      { id: "1", label: "Sign Transaction", status: "completed" },
                      { id: "2", label: "Network Confirmation", status: "completed" },
                      { id: "3", label: "Indexer Synchronization", status: "current", description: "Detecting your stream on-chain..." }
                    ]}
                    className="w-full max-w-sm"
                  />
                  <div className="mt-12 flex flex-col items-center gap-2">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0s" }} />
                      <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0.2s" }} />
                      <div className="w-2 h-2 rounded-full bg-accent animate-bounce" style={{ animationDelay: "0.4s" }} />
                    </div>
                    <p className="text-sm text-slate-400">This usually takes 5-10 seconds</p>
                  </div>
                </>
              ) : (
                <div className="text-center">
                  <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl mb-6">
                    <p className="text-red-400 text-sm">
                      We couldn&apos;t detect your stream yet, but it may still be processing.
                    </p>
                  </div>
                  <div className="flex flex-col gap-4 items-center">
                    <p className="text-sm text-slate-300">Transaction Hash:</p>
                    <code className="text-xs p-2 bg-slate-800 rounded break-all max-w-xs">{txHash}</code>
                    <a 
                      href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline text-sm font-medium flex items-center gap-2"
                    >
                      View on Stellar Expert
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  </div>
                  <Button 
                    variant="outline" 
                    className="mt-8"
                    onClick={onClose}
                  >
                    Go to Dashboard
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>

        {!isPolling && (
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
                <Button loading={isSubmitting} onClick={handleSubmit}>
                  Create Stream
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
