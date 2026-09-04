"use client";

import React, { useState, useCallback, useRef } from "react";
import { useWallet } from "@/context/wallet-context";
import { logger } from "@/lib/logger";
import { Stepper } from "../ui/Stepper";
import { Button } from "../ui/Button";
import {
  parseBatchCSV,
  generateSampleCSV,
  formatAmount,
  type BatchValidationSummary,
  type ValidatedBatchStreamEntry,
} from "@/lib/csv-parser";
import {
  createStream,
  toBaseUnits,
  toSorobanErrorMessage,
  getTokenAddress,
} from "@/lib/soroban";
import toast from "react-hot-toast";
import { useRouter } from "next/navigation";
import {
  Upload,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowLeft,
  Edit3,
  ChevronRight,
} from "lucide-react";

interface BatchStreamWizardProps {
  token: string;
  onTokenChange: (token: string) => void;
}

const STEPS = ["Upload & Template", "Validation & Review", "Execute"];

export function BatchStreamWizard({
  token,
  onTokenChange,
}: BatchStreamWizardProps) {
  const { session } = useWallet();
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(1);
  const [csvData, setCsvData] = useState<string>("");
  const [validation, setValidation] = useState<BatchValidationSummary | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionProgress, setExecutionProgress] = useState<{
    completed: number;
    total: number;
    txHashes: string[];
  }>({ completed: 0, total: 0, txHashes: [] });
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<{
    recipient: string;
    amount: string;
    durationSeconds: string;
    cliffSeconds: string;
  }>({ recipient: "", amount: "", durationSeconds: "", cliffSeconds: "" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file && (file.type === "text/csv" || file.name.endsWith(".csv"))) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        setCsvData(content);
        const result = parseBatchCSV(content);
        setValidation(result);
      };
      reader.readAsText(file);
    } else {
      toast.error("Please upload a CSV file");
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        setCsvData(content);
        const result = parseBatchCSV(content);
        setValidation(result);
      };
      reader.readAsText(file);
    }
  }, []);

  const handleDownloadSample = useCallback(() => {
    const csv = generateSampleCSV();
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flowfi-batch-template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Sample CSV downloaded");
  }, []);

  const handleStartEdit = useCallback((entry: ValidatedBatchStreamEntry) => {
    setEditingEntryId(entry.id);
    setEditValues({
      recipient: entry.recipient,
      amount: entry.amount,
      durationSeconds: entry.durationSeconds,
      cliffSeconds: entry.cliffSeconds,
    });
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (editingEntryId === null || !validation) return;

    // Update the CSV data
    const lines = csvData.split(/\r?\n/);
    const header = lines[0];
    const dataLines = lines.slice(1).filter((line) => line.trim().length > 0);

    if (editingEntryId > 0 && editingEntryId <= dataLines.length) {
      dataLines[editingEntryId - 1] = `${editValues.recipient},${editValues.amount},${editValues.durationSeconds},${editValues.cliffSeconds}`;
      const newCsv = [header, ...dataLines].join("\n");
      setCsvData(newCsv);

      const result = parseBatchCSV(newCsv);
      setValidation(result);
      toast.success("Entry updated");
    }

    setEditingEntryId(null);
  }, [editingEntryId, csvData, editValues, validation]);

  const handleCancelEdit = useCallback(() => {
    setEditingEntryId(null);
  }, []);

  const handleExecute = useCallback(async () => {
    if (!session || !validation) return;

    setIsExecuting(true);
    setExecutionProgress({ completed: 0, total: validation.validRows, txHashes: [] });

    const validEntries = validation.entries.filter((e) => e.isValid);
    const tokenAddress = getTokenAddress(token);
    let completed = 0;
    const txHashes: string[] = [];

    try {
      for (const entry of validEntries) {
        try {
          const amountBigInt = toBaseUnits(entry.amount);
          const durationBigInt = BigInt(parseInt(entry.durationSeconds, 10));

          const result = await createStream(session, {
            recipient: entry.recipient.trim(),
            tokenAddress,
            amount: amountBigInt,
            durationSeconds: durationBigInt,
          });

          if (result.success) {
            completed++;
            txHashes.push(result.txHash);
            setExecutionProgress({ completed, total: validEntries.length, txHashes: [...txHashes] });
          }
        } catch (err) {
          logger.error(`Failed to create stream for entry ${entry.id}:`, err);
          toast.error(`Failed for ${entry.recipient.slice(0, 10)}...: ${toSorobanErrorMessage(err)}`);
        }
      }

      if (completed > 0) {
        toast.success(`Successfully created ${completed} stream(s)`);
        router.push("/dashboard");
      }
    } catch (err) {
      toast.error(toSorobanErrorMessage(err));
    } finally {
      setIsExecuting(false);
    }
  }, [session, validation, token, router]);

  const handleNext = () => {
    if (currentStep === 1 && validation && validation.validRows > 0) {
      setCurrentStep(2);
    } else if (currentStep === 2 && validation && validation.validRows > 0) {
      setCurrentStep(3);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">Upload CSV File</h3>
                <p className="text-sm text-slate-400 mt-1">
                  Upload a CSV with recipient addresses and stream amounts
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleDownloadSample}
                className="flex items-center gap-2"
              >
                <Download className="h-4 w-4" />
                Download Template
              </Button>
            </div>

            {/* Token selector */}
            <div className="space-y-2">
              <label htmlFor="batch-token" className="text-sm font-medium text-slate-300">
                Token
              </label>
              <select
                id="batch-token"
                value={token}
                onChange={(e) => onTokenChange(e.target.value)}
                className="w-full rounded-xl border border-slate-800 bg-slate-900/50 p-3 outline-none focus:border-accent transition-colors"
              >
                <option value="USDC">USDC</option>
                <option value="XLM">XLM</option>
                <option value="EURC">EURC</option>
              </select>
            </div>

            {/* Dropzone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all ${
                isDragging
                  ? "border-accent bg-accent/10"
                  : "border-slate-700 hover:border-slate-600 hover:bg-slate-800/30"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileSelect}
                className="hidden"
              />
              <Upload className="h-12 w-12 mx-auto text-slate-500 mb-4" />
              <p className="text-lg font-medium">
                {isDragging ? "Drop your CSV here" : "Drag & drop your CSV file"}
              </p>
              <p className="text-sm text-slate-400 mt-2">
                or click to browse
              </p>
              <p className="text-xs text-slate-500 mt-4">
                Required columns: recipient, amount, duration_seconds, cliff_seconds
              </p>
            </div>

            {validation && (
              <div className="rounded-xl bg-slate-800/50 p-4">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-400" />
                  <span>
                    Parsed {validation.totalRows} rows:{" "}
                    <span className="text-green-400">{validation.validRows} valid</span>,{" "}
                    {validation.invalidRows > 0 && (
                      <span className="text-red-400">{validation.invalidRows} invalid</span>
                    )}
                  </span>
                </div>
              </div>
            )}
          </div>
        );

      case 2:
        return (
          <div className="space-y-6">
            {/* Summary Card */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="rounded-xl bg-slate-800/50 p-4">
                <p className="text-xs text-slate-400 mb-1">Total Gross Amount</p>
                <p className="text-lg font-bold text-accent">
                  {formatAmount(validation?.totalGrossAmount ?? 0n)} {token}
                </p>
              </div>
              <div className="rounded-xl bg-slate-800/50 p-4">
                <p className="text-xs text-slate-400 mb-1">Protocol Fee (2.5%)</p>
                <p className="text-lg font-bold text-yellow-400">
                  {formatAmount(validation?.totalProtocolFee ?? 0n)} {token}
                </p>
              </div>
              <div className="rounded-xl bg-slate-800/50 p-4">
                <p className="text-xs text-slate-400 mb-1">Net Distributed</p>
                <p className="text-lg font-bold text-green-400">
                  {formatAmount(validation?.totalNetDistributed ?? 0n)} {token}
                </p>
              </div>
              <div className="rounded-xl bg-slate-800/50 p-4">
                <p className="text-xs text-slate-400 mb-1">Number of Streams</p>
                <p className="text-lg font-bold">{validation?.validRows ?? 0}</p>
              </div>
            </div>

            {/* Validation Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700">
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">#</th>
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">Recipient</th>
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">Amount</th>
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">Duration</th>
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">Cliff</th>
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">Status</th>
                    <th className="text-left py-3 px-4 text-slate-400 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {validation?.entries.map((entry) => (
                    <tr
                      key={entry.id}
                      className={`border-b border-slate-800 ${
                        !entry.isValid ? "bg-red-500/5" : ""
                      }`}
                    >
                      <td className="py-3 px-4">{entry.id}</td>
                      <td className="py-3 px-4">
                        {editingEntryId === entry.id ? (
                          <input
                            type="text"
                            value={editValues.recipient}
                            onChange={(e) =>
                              setEditValues({ ...editValues, recipient: e.target.value })
                            }
                            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm"
                          />
                        ) : (
                          <span className="font-mono text-xs break-all">
                            {entry.recipient.length > 20
                              ? `${entry.recipient.slice(0, 10)}...${entry.recipient.slice(-10)}`
                              : entry.recipient}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {editingEntryId === entry.id ? (
                          <input
                            type="text"
                            value={editValues.amount}
                            onChange={(e) =>
                              setEditValues({ ...editValues, amount: e.target.value })
                            }
                            className="w-24 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm"
                          />
                        ) : (
                          <span>{entry.amount}</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {editingEntryId === entry.id ? (
                          <input
                            type="text"
                            value={editValues.durationSeconds}
                            onChange={(e) =>
                              setEditValues({ ...editValues, durationSeconds: e.target.value })
                            }
                            className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm"
                          />
                        ) : (
                          <span>{entry.durationSeconds}s</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {editingEntryId === entry.id ? (
                          <input
                            type="text"
                            value={editValues.cliffSeconds}
                            onChange={(e) =>
                              setEditValues({ ...editValues, cliffSeconds: e.target.value })
                            }
                            className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm"
                          />
                        ) : (
                          <span>{entry.cliffSeconds}s</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {entry.isValid ? (
                          <span className="inline-flex items-center gap-1 text-green-400 text-xs">
                            <CheckCircle2 className="h-3 w-3" />
                            Valid
                          </span>
                        ) : (
                          <div className="space-y-1">
                            {entry.errors.map((err, i) => (
                              <span key={i} className="inline-flex items-center gap-1 text-red-400 text-xs">
                                <XCircle className="h-3 w-3" />
                                {err.message}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {editingEntryId === entry.id ? (
                          <div className="flex gap-1">
                            <button
                              onClick={handleSaveEdit}
                              className="text-xs text-green-400 hover:text-green-300"
                            >
                              Save
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              className="text-xs text-slate-400 hover:text-slate-300"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleStartEdit(entry)}
                            className="text-slate-400 hover:text-accent transition-colors"
                          >
                            <Edit3 className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );

      case 3:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h3 className="text-xl font-bold mb-2">Ready to Execute</h3>
              <p className="text-slate-400">
                You are about to create {validation?.validRows} payment stream(s)
              </p>
            </div>

            <div className="rounded-xl bg-accent/10 border border-accent/30 p-6">
              <div className="grid grid-cols-2 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-accent">
                    {validation?.validRows ?? 0}
                  </p>
                  <p className="text-sm text-slate-400">Streams</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {formatAmount(validation?.totalNetDistributed ?? 0n)} {token}
                  </p>
                  <p className="text-sm text-slate-400">Total Net Amount</p>
                </div>
              </div>
            </div>

            {isExecuting ? (
              <div className="space-y-4">
                <div className="flex items-center justify-center gap-3">
                  <Loader2 className="h-6 w-6 text-accent animate-spin" />
                  <span>Creating streams...</span>
                </div>
                <div className="w-full bg-slate-800 rounded-full h-2">
                  <div
                    className="bg-accent h-2 rounded-full transition-all duration-300"
                    style={{
                      width: `${(executionProgress.completed / executionProgress.total) * 100}%`,
                    }}
                  />
                </div>
                <p className="text-center text-sm text-slate-400">
                  {executionProgress.completed} / {executionProgress.total} completed
                </p>
                {executionProgress.txHashes.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <p className="text-sm text-slate-400">Created streams:</p>
                    {executionProgress.txHashes.map((hash, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <CheckCircle2 className="h-3 w-3 text-green-400" />
                        <span className="font-mono truncate">{hash.slice(0, 20)}...</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex justify-center">
                <Button
                  onClick={handleExecute}
                  disabled={!session || (validation?.validRows ?? 0) === 0}
                  className="px-8 py-3"
                >
                  Execute Batch Creation
                </Button>
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => router.push("/dashboard")}
          className="p-2 rounded-lg hover:bg-white/5 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold">Batch Stream Creation</h1>
          <p className="text-slate-400 text-sm">
            Upload a CSV to create multiple payment streams at once
          </p>
        </div>
      </div>

      <Stepper steps={STEPS} currentStep={currentStep} />

      <div className="glass-card rounded-3xl border-slate-800 p-8">
        {renderStepContent()}

        <div className="flex justify-between mt-8 pt-6 border-t border-slate-800">
          <div>
            {currentStep > 1 && !isExecuting && (
              <Button variant="outline" onClick={handleBack}>
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            {currentStep < 3 && (
              <Button
                onClick={handleNext}
                disabled={
                  (currentStep === 1 && (!validation || validation.validRows === 0)) ||
                  (currentStep === 2 && validation !== null && validation.invalidRows === validation.totalRows)
                }
                className="flex items-center gap-2"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


