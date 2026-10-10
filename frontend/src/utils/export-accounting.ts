import type { ExportFormat, Stream } from '@/types/analytics';
import { toDecimalString } from '@/utils/stream-metrics';

export interface ExportColumn {
  key: string;
  header: string;
}

export const ACCOUNTING_COLUMNS = [
  { key: 'streamId', header: 'Stream ID' },
  { key: 'creationDate', header: 'Creation Date' },
  { key: 'senderAddress', header: 'Sender Address' },
  { key: 'recipientAddress', header: 'Recipient Address' },
  { key: 'tokenSymbol', header: 'Token Symbol' },
  { key: 'tokenContractAddress', header: 'Token Contract Address' },
  { key: 'depositedAmount', header: 'Deposited Amount' },
  { key: 'withdrawnAmount', header: 'Withdrawn Amount' },
  { key: 'remainingBalance', header: 'Remaining Balance' },
  { key: 'claimableBalance', header: 'Claimable Balance' },
  { key: 'startTimestamp', header: 'Start Timestamp' },
  { key: 'endTimestamp', header: 'End Timestamp' },
  { key: 'cliffTimestamp', header: 'Cliff Timestamp' },
  { key: 'status', header: 'Status' },
  { key: 'lastActionLedger', header: 'Last Action Ledger' },
] as const satisfies ReadonlyArray<ExportColumn>;

export type AccountingColumnKey = (typeof ACCOUNTING_COLUMNS)[number]['key'];
export type AccountingRow = Record<AccountingColumnKey, string>;

export const QUICKBOOKS_COLUMNS: ExportColumn[] = [
  { key: 'journalNo', header: 'Journal No.' },
  { key: 'journalDate', header: 'Journal Date' },
  { key: 'account', header: 'Account' },
  { key: 'debit', header: 'Debit' },
  { key: 'credit', header: 'Credit' },
  { key: 'description', header: 'Description' },
  { key: 'name', header: 'Name' },
  { key: 'currency', header: 'Currency' },
];

function toIsoString(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '';
  return new Date(unixSeconds * 1000).toISOString();
}

function toIsoDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function decimalsOf(stream: Stream): number {
  const decimals = stream.token?.decimals;
  return Number.isFinite(decimals) ? Number(decimals) : 18;
}

export function buildAccountingRow(stream: Stream): AccountingRow {
  const decimals = decimalsOf(stream);
  return {
    streamId: stream.id,
    creationDate: toIsoDate(stream.createdAt),
    senderAddress: stream.sender,
    recipientAddress: stream.recipient,
    tokenSymbol: stream.token?.symbol ?? '',
    tokenContractAddress: stream.token?.address ?? '',
    depositedAmount: toDecimalString(stream.depositedAmount, decimals),
    withdrawnAmount: toDecimalString(stream.withdrawnAmount, decimals),
    remainingBalance: toDecimalString(stream.remainingBalance, decimals),
    claimableBalance: toDecimalString(stream.claimableBalance, decimals),
    startTimestamp: toIsoString(stream.startTimestamp),
    endTimestamp: toIsoString(stream.endTimestamp),
    cliffTimestamp: toIsoString(stream.cliffTimestamp),
    status: stream.status,
    lastActionLedger: String(stream.lastActionLedger ?? ''),
  };
}

export function buildAccountingRows(streams: Stream[]): AccountingRow[] {
  return streams.map(buildAccountingRow);
}

export function buildQuickBooksRows(streams: Stream[]): Array<Record<string, string>> {
  return streams.map((stream) => {
    const decimals = decimalsOf(stream);
    const symbol = stream.token?.symbol ?? '';
    const deposited = toDecimalString(stream.depositedAmount, decimals);
    const withdrawn = toDecimalString(stream.withdrawnAmount, decimals);
    return {
      journalNo: stream.id,
      journalDate: toIsoDate(stream.createdAt).slice(0, 10),
      account: `Crypto Assets:${symbol}`,
      debit: deposited,
      credit: withdrawn,
      description: `Stream ${stream.id} -> ${stream.recipient}`,
      name: stream.recipient,
      currency: symbol,
    };
  });
}

export interface CsvOptions {
  bom?: boolean;
  sanitizeFormulas?: boolean;
  lineEnding?: '\n' | '\r\n';
}

const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;

function escapeCsvValue(raw: unknown, sanitizeFormulas: boolean): string {
  let value = raw === null || raw === undefined ? '' : String(raw);

  if (sanitizeFormulas && !NUMERIC_PATTERN.test(value) && /^[=+\-@\t\r]/.test(value)) {
    value = `'${value}`;
  }

  if (/[",\n\r]/.test(value)) {
    value = `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: ReadonlyArray<ExportColumn>,
  options: CsvOptions = {},
): string {
  const { bom = true, sanitizeFormulas = true, lineEnding = '\n' } = options;

  const header = columns.map((column) => escapeCsvValue(column.header, false)).join(',');

  const body = rows.map((row) =>
    columns.map((column) => escapeCsvValue(row[column.key], sanitizeFormulas)).join(','),
  );

  const csv = [header, ...body].join(lineEnding);
  return bom ? `\uFEFF${csv}` : csv;
}

export interface ExportBundle {
  content: string;
  mimeType: string;
  filename: string;
}

export interface ExportOptions {
  filenamePrefix?: string;
  generatedAt?: Date;
  csv?: CsvOptions;
}

function buildFilename(prefix: string, format: ExportFormat, generatedAt: Date): string {
  const stamp = generatedAt.toISOString().slice(0, 10);
  const extension = format === 'json' ? 'json' : 'csv';
  const qualifier = format === 'csv' ? '' : `-${format}`;
  return `${prefix}${qualifier}-${stamp}.${extension}`;
}

export function buildExport(
  streams: Stream[],
  format: ExportFormat,
  options: ExportOptions = {},
): ExportBundle {
  const {
    filenamePrefix = 'flowfi-stream-accounting',
    generatedAt = new Date(),
    csv: csvOptions,
  } = options;

  if (format === 'quickbooks') {
    const rows = buildQuickBooksRows(streams);
    return {
      content: toCsv(rows, QUICKBOOKS_COLUMNS, csvOptions),
      mimeType: 'text/csv;charset=utf-8',
      filename: buildFilename(filenamePrefix, 'quickbooks', generatedAt),
    };
  }

  if (format === 'json') {
    const payload = {
      generatedAt: generatedAt.toISOString(),
      streamCount: streams.length,
      columns: ACCOUNTING_COLUMNS.map((column) => column.header),
      streams: buildAccountingRows(streams),
    };
    return {
      content: JSON.stringify(payload, null, 2),
      mimeType: 'application/json;charset=utf-8',
      filename: buildFilename(filenamePrefix, 'json', generatedAt),
    };
  }

  const rows = buildAccountingRows(streams);
  return {
    content: toCsv(rows, ACCOUNTING_COLUMNS, csvOptions),
    mimeType: 'text/csv;charset=utf-8',
    filename: buildFilename(filenamePrefix, 'csv', generatedAt),
  };
}

export function downloadExport(bundle: ExportBundle): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const blob = new Blob([bundle.content], { type: bundle.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = bundle.filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportStreams(
  streams: Stream[],
  format: ExportFormat,
  options: ExportOptions = {},
): ExportBundle {
  const bundle = buildExport(streams, format, options);
  downloadExport(bundle);
  return bundle;
}
