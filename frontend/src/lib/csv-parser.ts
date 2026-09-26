/**
 * CSV Parser & Validator for Batch Stream Payroll Upload
 * 
 * Parses CSV files with columns: recipient, amount, duration_seconds, cliff_seconds
 * Validates each row against Stellar address format and numeric constraints.
 */

export interface BatchStreamEntry {
  id: number;
  recipient: string;
  amount: string;
  durationSeconds: string;
  cliffSeconds: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidatedBatchStreamEntry extends BatchStreamEntry {
  errors: ValidationError[];
  isValid: boolean;
}

export interface BatchValidationSummary {
  entries: ValidatedBatchStreamEntry[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  totalGrossAmount: bigint;
  totalProtocolFee: bigint;
  totalNetDistributed: bigint;
  protocolFeeRate: bigint;
}

const PROTOCOL_FEE_RATE = 250n; // 2.5% = 250 basis points
const BASIS_POINTS = 10000n;
const TOKEN_DECIMALS = 7;

/**
 * Validates a Stellar public key format (starts with G, 56 chars, Base32)
 */
function isValidStellarPublicKey(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  return /^G[A-Z2-7]{55}$/.test(normalized);
}

/**
 * Validates a federated name (contains @)
 */
function isValidFederatedName(value: string): boolean {
  return value.includes("@") && value.length > 3;
}

/**
 * Validates a single batch stream entry
 */
export function validateEntry(entry: BatchStreamEntry): ValidationError[] {
  const errors: ValidationError[] = [];

  // Validate recipient
  const recipient = entry.recipient.trim();
  if (!recipient) {
    errors.push({ field: "recipient", message: "Recipient is required" });
  } else if (!isValidStellarPublicKey(recipient) && !isValidFederatedName(recipient)) {
    errors.push({
      field: "recipient",
      message: "Must be a valid Stellar G... public key or federated name (user@domain)"
    });
  }

  // Validate amount
  const amountStr = entry.amount.trim();
  if (!amountStr) {
    errors.push({ field: "amount", message: "Amount is required" });
  } else {
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) {
      errors.push({ field: "amount", message: "Amount must be a number" });
    } else if (amount <= 0) {
      errors.push({ field: "amount", message: "Amount must be positive" });
    } else if (amountStr.includes(".")) {
      const decimals = amountStr.split(".")[1]?.length ?? 0;
      if (decimals > TOKEN_DECIMALS) {
        errors.push({
          field: "amount",
          message: `Maximum ${TOKEN_DECIMALS} decimal places allowed`
        });
      }
    }
  }

  // Validate duration_seconds
  const durationStr = entry.durationSeconds.trim();
  if (!durationStr) {
    errors.push({ field: "durationSeconds", message: "Duration is required" });
  } else {
    const duration = parseInt(durationStr, 10);
    if (isNaN(duration) || duration <= 0) {
      errors.push({
        field: "durationSeconds",
        message: "Duration must be a positive integer"
      });
    }
  }

  // Validate cliff_seconds
  const cliffStr = entry.cliffSeconds.trim();
  if (cliffStr) {
    const cliff = parseInt(cliffStr, 10);
    if (isNaN(cliff) || cliff < 0) {
      errors.push({
        field: "cliffSeconds",
        message: "Cliff must be a non-negative integer"
      });
    } else {
      const duration = parseInt(durationStr, 10);
      if (!isNaN(duration) && cliff >= duration) {
        errors.push({
          field: "cliffSeconds",
          message: "Cliff must be less than duration"
        });
      }
    }
  }

  return errors;
}

/**
 * Parses a CSV string into batch stream entries with validation
 */
export function parseBatchCSV(csvContent: string): BatchValidationSummary {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return {
      entries: [],
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      totalGrossAmount: 0n,
      totalProtocolFee: 0n,
      totalNetDistributed: 0n,
      protocolFeeRate: PROTOCOL_FEE_RATE,
    };
  }

  // Parse header to find column indices
  const header = parseCSVLine(lines[0] as string);
  const recipientIdx = header.findIndex((h) => h.toLowerCase() === "recipient");
  const amountIdx = header.findIndex((h) => h.toLowerCase() === "amount");
  const durationIdx = header.findIndex(
    (h) => h.toLowerCase() === "duration_seconds" || h.toLowerCase() === "duration"
  );
  const cliffIdx = header.findIndex(
    (h) => h.toLowerCase() === "cliff_seconds" || h.toLowerCase() === "cliff"
  );

  // Validate required columns exist
  if (recipientIdx === -1 || amountIdx === -1 || durationIdx === -1) {
    return {
      entries: [],
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      totalGrossAmount: 0n,
      totalProtocolFee: 0n,
      totalNetDistributed: 0n,
      protocolFeeRate: PROTOCOL_FEE_RATE,
    };
  }

  const entries: ValidatedBatchStreamEntry[] = [];
  let totalGrossAmount = 0n;
  let totalProtocolFee = 0n;

  for (let i = 1; i < lines.length; i++) {
    const columns = parseCSVLine(lines[i] as string);
    if (columns.length === 0) continue;

    const entry: BatchStreamEntry = {
      id: i,
      recipient: columns[recipientIdx] as string ?? "",
      amount: columns[amountIdx] as string ?? "",
      durationSeconds: columns[durationIdx] as string ?? "",
      cliffSeconds: cliffIdx >= 0 ? ((columns[cliffIdx] as string) ?? "") : "0",
    };

    const errors = validateEntry(entry);

    // Calculate amounts for valid entries
    if (errors.length === 0) {
      const amountStr = entry.amount.trim();
      const amountUnits = BigInt(Math.round(parseFloat(amountStr) * 10 ** TOKEN_DECIMALS));
      const protocolFee = (amountUnits * PROTOCOL_FEE_RATE) / BASIS_POINTS;
      totalGrossAmount += amountUnits;
      totalProtocolFee += protocolFee;
    }

    entries.push({
      ...entry,
      errors,
      isValid: errors.length === 0,
    });
  }

  return {
    entries,
    totalRows: entries.length,
    validRows: entries.filter((e) => e.isValid).length,
    invalidRows: entries.filter((e) => !e.isValid).length,
    totalGrossAmount,
    totalProtocolFee,
    totalNetDistributed: totalGrossAmount - totalProtocolFee,
    protocolFeeRate: PROTOCOL_FEE_RATE,
  };
}

/**
 * Parses a single CSV line, handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }

  result.push(current);
  return result;
}

/**
 * Generates a sample CSV string for download
 */
export function generateSampleCSV(): string {
  return `recipient,amount,duration_seconds,cliff_seconds
GBBDIOEJGZHV5GFZQB4T7NKZQKRVNDQYXKW6Z3VJXZAVFQKZ5HM5J2EU,1500.00,2592000,0
GBCKE5YFZTPDRGGB7FSC7GBF7S4D57GZB2CZ6BHWY5G7J74D7C236M2X,2200.50,5184000,604800
GCBA6C5YC3FXYC4KC7LC5MC2P3C4R5C6C7U4VC5WC2X3YC2Z3AC4BC5C,1000.00,86400,0`;
}

/**
 * Formats a base units amount to human readable string
 */
export function formatAmount(amount: bigint, decimals: number = TOKEN_DECIMALS): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole.toString()}.${fraction}` : whole.toString();
}
