// CSV Export utilities for FlowFi

type CsvRow = Record<string, unknown>;

const escapeCsvCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }

    const text = value instanceof Date ? value.toLocaleString() : String(value);
    const escaped = text.replace(/"/g, '""');

    return /("|,|\n)/.test(escaped) ? `"${escaped}"` : escaped;
};

export const convertArrayToCSV = <T extends CsvRow>(
    arr: T[] | null | undefined
): string => {
    if (!arr || arr.length === 0) return '';

    const separator = ',';
    const keys = Object.keys(arr[0]);

    return [
        keys.join(separator),
        ...arr.map((row) =>
            keys.map((key) => escapeCsvCell(row[key])).join(separator)
        ),
    ].join('\n');
};

export const downloadCSV = <T extends CsvRow>(data: T[], filename: string) => {
    const csvData = convertArrayToCSV(data);
    const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
};
