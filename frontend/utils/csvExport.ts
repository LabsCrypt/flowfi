export const convertArrayToCSV = (arr: any[]): string => {
    if (!arr || !arr.length) return '';
    const separator = ',';
    const keys = Object.keys(arr[0]);
    const csvContent =
        keys.join(separator) +
        '\n' +
        arr
            .map((row) => {
                return keys
                    .map((k) => {
                        let cell = row[k] === null || row[k] === undefined ? '' : row[k];
                        cell =
                            cell instanceof Date
                                ? cell.toLocaleString()
                                : cell.toString().replace(/"/g, '""');
                        if (cell.search(/("|,|\n)/g) >= 0) {
                            cell = `"${cell}"`;
                        }
                        return cell;
                    })
                    .join(separator);
            })
            .join('\n');
    return csvContent;
};

export const downloadCSV = (data: any[], filename: string) => {
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
