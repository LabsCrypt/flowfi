"use client";
import React from "react";
import type { StreamFormData } from "./StreamCreationWizard";

export interface StreamTemplate {
  id: string;
  name: string;
  description: string;
  values: Partial<StreamFormData>;
  builtIn?: boolean;
}

interface TemplateStepProps {
  templates: StreamTemplate[];
  selectedTemplateId: string;
  onSelectTemplate: (templateId: string) => void;
  customTemplateName: string;
  onCustomTemplateNameChange: (value: string) => void;
  onSaveCustomTemplate: () => void;
  saveDisabled?: boolean;
  saveMessage?: string | null;
}

export const TemplateStep: React.FC<TemplateStepProps> = ({
  templates,
  selectedTemplateId,
  onSelectTemplate,
  customTemplateName,
  onCustomTemplateNameChange,
  onSaveCustomTemplate,
  saveDisabled,
  saveMessage,
}) => {
  const builtInTemplates = templates.filter((template) => template.builtIn);
  const customTemplates = templates.filter((template) => !template.builtIn);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold mb-2">Choose a Template</h3>
        <p className="text-sm text-slate-400">
          Start from a common setup. You can edit everything in the next steps.
        </p>
      </div>

      <div>
        <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-3">Built-in</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {builtInTemplates.map((template) => {
            const isSelected = template.id === selectedTemplateId;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onSelectTemplate(template.id)}
                className={`rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? "border-accent bg-accent/10 shadow-lg shadow-accent/15"
                    : "border-glass-border bg-glass hover:border-glass-highlight"
                }`}
              >
                <p className="font-semibold text-foreground">{template.name}</p>
                <p className="mt-1 text-xs text-slate-400">{template.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-3">Custom</h4>
        {customTemplates.length === 0 ? (
          <p className="text-sm text-slate-500">No custom templates yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {customTemplates.map((template) => {
              const isSelected = template.id === selectedTemplateId;
              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => onSelectTemplate(template.id)}
                  className={`rounded-xl border p-4 text-left transition-all ${
                    isSelected
                      ? "border-accent bg-accent/10 shadow-lg shadow-accent/15"
                      : "border-glass-border bg-glass hover:border-glass-highlight"
                  }`}
                >
                  <p className="font-semibold text-foreground">{template.name}</p>
                  <p className="mt-1 text-xs text-slate-400">{template.description}</p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-glass-border bg-glass p-4 space-y-3">
        <p className="text-sm font-semibold text-foreground">Save Current Values as Template</p>
        <p className="text-xs text-slate-400">
          Save your current amount, duration, token, and tag to reuse later.
        </p>
        <div className="flex flex-col md:flex-row gap-3">
          <input
            type="text"
            value={customTemplateName}
            onChange={(e) => onCustomTemplateNameChange(e.target.value)}
            placeholder="Template name"
            className="w-full rounded-lg bg-background/40 border border-glass-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="button"
            onClick={onSaveCustomTemplate}
            disabled={saveDisabled}
            className="rounded-lg border border-accent/50 px-4 py-2 text-sm font-semibold text-accent hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save Template
          </button>
        </div>
        {saveMessage && <p className="text-xs text-slate-400">{saveMessage}</p>}
      </div>
    </div>
  );
};
