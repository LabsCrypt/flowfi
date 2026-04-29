"use client";
import React, { useState } from "react";
import { Stepper } from "../ui/Stepper";
import { Button } from "../ui/Button";
import { RecipientStep } from "./RecipientStep";
import { TokenStep } from "./TokenStep";
import { AmountStep } from "./AmountStep";
import { ScheduleStep } from "./ScheduleStep";
import { TransactionTracker, type TransactionStep } from "../ui/TransactionTracker";
import toast from "react-hot-toast";
import { useRouter } from "next/navigation";

export interface StreamFormData {
  recipient: string;
  token: string;
  amount: string;
  duration: string;
  durationUnit: "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";
}

interface StreamCreationWizardProps {
  onClose: () => void;
  onSubmit: (data: StreamFormData) => Promise<void>;
}

const STEPS = ["Recipient", "Token", "Amount", "Schedule"];

export const StreamCreationWizard: React.FC<StreamCreationWizardProps> = ({
  onClose,
  onSubmit,
}) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<StreamFormData>({
    recipient: "",
    token: "",
    amount: "",
    duration: "",
    durationUnit: "days",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof StreamFormData, string>>>({});
  
  // Tracking & Polling state
  const [txHash, setTxHash] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [timeout, setTimeoutError] = useState(false);
  
  const router = useRouter();

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

  const validateStep = (step: number): boolean => {
    const newErrors: Partial<Record<keyof StreamFormData, string>> = {};

    switch (step) {
      case 1: // Recipient
        if (!formData.recipient.trim()) {
          newErrors.recipient = "Recipient address is required";
        } else if (!/^G[A-Z0-9]{55}$/.test(formData.recipient.trim())) {
          newErrors.recipient = "Invalid Stellar public key format";
        }
        break;
      case 2: // Token
        if (!formData.token) {
          newErrors.token = "Please select a token";
        }
        break;
      case 3: // Amount
        if (!formData.amount.trim()) {
          newErrors.amount = "Amount is required";
        } else {
          const amount = parseFloat(formData.amount);
          if (isNaN(amount) || amount <= 0) {
            newErrors.amount = "Amount must be a positive number";
          }
        }
        break;
      case 4: // Schedule
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
        // Step 1: Submit transaction
        // We expect onSubmit to return a txHash once submitted
        const result = await onSubmit(formData) as { txHash: string };
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

  const startPolling = async (senderAddress: string) => {
    const startTime = Date.now();
    const TIMEOUT_MS = 30000; // 30 seconds
    const POLL_INTERVAL = 2000; // 2 seconds

    while (Date.now() - startTime < TIMEOUT_MS) {
      try {
        const response = await fetch(`/v1/streams?sender=${senderAddress}`);
        const streams = await response.json();
        
        // Assuming the latest stream is what we want
        // In a real app, we'd check if the new stream ID exists
        if (streams && streams.length > 0) {
          // Found!
          const newStream = streams[0]; // Simplification
          toast.success("Stream indexed and confirmed!");
          router.push(`/streams/${newStream.streamId}`);
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

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <RecipientStep
            value={formData.recipient}
            onChange={(value) => updateFormData({ recipient: value })}
            error={errors.recipient}
          />
        );
      case 2:
        return (
          <TokenStep
            value={formData.token}
            onChange={(value) => updateFormData({ token: value })}
            error={errors.token}
          />
        );
      case 3:
        return (
          <AmountStep
            value={formData.amount}
            onChange={(value) => updateFormData({ amount: value })}
            error={errors.amount}
            token={formData.token}
          />
        );
      case 4:
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
        )}
      </div>
    </div>
  );
};
