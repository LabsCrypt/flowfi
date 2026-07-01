"use client";
import React from "react";

interface StepperProps {
  steps: string[];
  currentStep: number;
  className?: string;
}

export const Stepper: React.FC<StepperProps> = ({
  steps,
  currentStep,
  className = "",
}) => {
  return (
    <nav className={`stepper ${className}`} aria-label="Progress">
      <ol className="stepper__container">
        {steps.map((step, index) => {
          const stepNumber = index + 1;
          const isActive = stepNumber === currentStep;
          const isCompleted = stepNumber < currentStep;

          return (
            <React.Fragment key={step}>
              <li className="stepper__step" aria-current={isActive ? "step" : undefined}>
                <div
                  className={`stepper__circle ${
                    isActive
                      ? "stepper__circle--active"
                      : isCompleted
                        ? "stepper__circle--completed"
                        : "stepper__circle--upcoming"
                  }`}
                >
                  {isCompleted ? (
                    <svg
                      className="stepper__check"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    <span className="stepper__number">{stepNumber}</span>
                  )}
                </div>
                <span
                  className={`stepper__label ${
                    isActive
                      ? "stepper__label--active"
                      : isCompleted
                        ? "stepper__label--completed"
                        : "stepper__label--upcoming"
                  }`}
                >
                  {step}
                  <span className="sr-only">
                    {isActive ? " (current step)" : isCompleted ? " (completed)" : " (upcoming)"}
                  </span>
                </span>
              </li>
              {index < steps.length - 1 && (
                <div
                  className={`stepper__line ${
                    isCompleted ? "stepper__line--completed" : ""
                  }`}
                  aria-hidden="true"
                />
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
};
