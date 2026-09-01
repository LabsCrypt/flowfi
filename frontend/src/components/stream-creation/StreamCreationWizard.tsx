"use client";
import React, { useState } from "react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { logger } from "@/lib/logger";
import { Stepper } from "../ui/Stepper";
import { Button } from "../ui/Button";
import { RecipientStep } from "./RecipientStep";
import { TokenStep } from "./TokenStep";
import { AmountStep } from "./AmountStep";
import { ScheduleStep } from "./ScheduleStep";
import { TemplateStep } from "./TemplateStep";
import toast from "react-hot-toast";
import { useRouter } from "next/navigation";
import { getApiBaseUrl } from "@/lib/api/_shared";
import {
  useStreamForm,
  type StreamFormData,
} from "@/hooks/useStreamForm";

// Re-export StreamFormData so existing imports keep working
export type { StreamFormData };

interface StreamCreationWizardProps {
  onClose: () => void;
  onSubmit: (data: StreamFormData) => Promise<void>;
  walletPublicKey?: string;
}

const STEPS = ["Template", "Recipient", "Token", "Amount", "Schedule"];

export const StreamCreationWizard: React.FC<StreamCreationWizardProps> = ({
  onClose,
  onSubmit,
  walletPublicKey,
}) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [customTemplateName, setCustomTemplateName] = useState("");
  const [templateSaveMessage, setTemplateSaveMessage] = useState<string | null>(null);

  // Tracking & Polling state (Issue #378)
  const [txHash, setTxHash] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [timeoutError, setTimeoutError] = useState(false);

  const router = useRouter();

  // ── Shared form hook (replaces ad-hoc validation + balance + templates) ──
  const {
    formData,
    errors,
    updateFormData,
    validateStep,
    walletBalance,
    walletBalanceLoading,
    walletBalanceError,
    setMaxAmount,
    allTemplates,
    selectedTemplateId,
    applyTemplate: applyTemplateHook,
    saveCustomTemplate,
  } = useStreamForm({
    walletPublicKey,
    initialData: {
      token: "USDC",
      amount: "5000",
      duration: "1",
      durationUnit: "months",
      descriptionTag: "salary",
    },
  });

  const dialogRef = useModalDialog({
    onClose,
    isCloseDisabled: isSubmitting || isPolling,
  });

  const handleApplyTemplate = (templateId: string) => {
    const msg = applyTemplateHook(templateId);
    if (msg) setTemplateSaveMessage(msg);
  };

  const handleSaveCustomTemplate = () => {
    const errorMsg = saveCustomTemplate(customTemplateName);
    if (errorMsg) {
      setTemplateSaveMessage(errorMsg);
    } else {
      setTemplateSaveMessage(`Saved custom template "${customTemplateName.trim()}".`);
      setCustomTemplateName("");
    }
  };

  const handleNext = () => {
    if (validateStep(currentStep)) {
      if (currentStep < STEPS.length) {
        setCurrentStep(currentStep + 1);
        // Scroll to top when moving to next step
        const modal = document.querySelector('.glass-card');
        if (modal && typeof modal.scrollTo === 'function') {
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
      if (typeof window.scrollTo === 'function') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  };

  const startPolling = async (senderAddress: string) => {
    const startTime = Date.now();
    const TIMEOUT_MS = 30000; // 30 seconds
    const POLL_INTERVAL = 2000; // 2 seconds
    const baseUrl = getApiBaseUrl();

    while (Date.now() - startTime < TIMEOUT_MS) {
      try {
        const response = await fetch(`${baseUrl}/v1/streams?sender=${senderAddress}`);
        const payload = await response.json();
        const streams = Array.isArray(payload) ? payload : (payload.data ?? []);
        
        // Assuming the latest stream is what we want
        if (streams && streams.length > 0) {
          // Found!
          const newStream = streams[0]; // Simplification
          toast.success("Stream indexed and confirmed!");
          router.push(`/streams/${newStream.streamId}`); // Updated path to match new structure
          return;
        }
      } catch (e) {
        logger.warn("Polling error:", e);
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
        await startPolling(walletPublicKey || "");
        
      } catch (error) {
        logger.error("Failed to create stream:", error);
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
            selectedTemplateId={selectedTemplateId ?? "monthly-salary"}
            onSelectTemplate={handleApplyTemplate}
            customTemplateName={customTemplateName}
            onCustomTemplateNameChange={setCustomTemplateName}
            onSaveCustomTemplate={handleSaveCustomTemplate}
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
            onSetMax={setMaxAmount}
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

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stream-creation-wizard-title"
      onClick={(e) => {
        // Close on backdrop click
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="glass-card relative z-10 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-glass-border p-8"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 id="stream-creation-wizard-title" className="text-2xl font-bold">Create Payment Stream</h2>
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
                {timeoutError ? "Confirmation Timeout" : "Waiting for confirmation..."}
              </h3>
              
              {!timeoutError ? (
                <>
                  <div className="w-full max-w-sm mx-auto space-y-4">
                    <div className="flex items-center gap-4">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent">
                        <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                      <div className="flex-1">
                        <p className="font-medium">Sign Transaction</p>
                        <p className="text-xs text-slate-400">Confirmed</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent">
                        <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                      <div className="flex-1">
                        <p className="font-medium">Network Confirmation</p>
                        <p className="text-xs text-slate-400">Confirmed</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-accent motion-reduce:animate-none">
                        <div className="h-2 w-2 rounded-full bg-accent" />
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-accent">Indexer Synchronization</p>
                        <p className="text-xs text-slate-400">Detecting your stream on-chain...</p>
                      </div>
                    </div>
                  </div>
                  <div className="mt-12 flex flex-col items-center gap-2">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 rounded-full bg-accent motion-reduce:animate-none" style={{ animationDelay: "0s" }} />
                      <div className="w-2 h-2 rounded-full bg-accent motion-reduce:animate-none" style={{ animationDelay: "0.2s" }} />
                      <div className="w-2 h-2 rounded-full bg-accent motion-reduce:animate-none" style={{ animationDelay: "0.4s" }} />
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
              <Button variant="outline" onClick={onClose} disabled={isSubmitting || isPolling}>
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
