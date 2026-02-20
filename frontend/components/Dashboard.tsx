import React from 'react';
import { downloadCSV } from '../utils/csvExport';

interface StreamData {
    id: string;
    date: string;
    recipient: string;
    amount: number;
    token: string;
    status: 'Active' | 'Completed' | 'Cancelled';
}

const mockStreams: StreamData[] = [
    { id: '1', date: '2023-10-25', recipient: 'G...ABCD', amount: 500, token: 'USDC', status: 'Completed' },
    { id: '2', date: '2023-10-26', recipient: 'G...EFGH', amount: 1200, token: 'XLM', status: 'Active' },
    { id: '3', date: '2023-10-27', recipient: 'G...IJKL', amount: 300, token: 'EURC', status: 'Cancelled' },
    { id: '4', date: '2023-10-28', recipient: 'G...MNOP', amount: 1000, token: 'USDC', status: 'Completed' },
    { id: '5', date: '2023-10-29', recipient: 'G...QRST', amount: 750, token: 'USDC', status: 'Active' },
];

const Dashboard: React.FC = () => {
    const handleExport = () => {
        downloadCSV(mockStreams, 'flowfi-stream-history.csv');
    };

    return (
        <div className="p-8">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Stream History</h1>
                <button
                    onClick={handleExport}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded shadow transition-colors"
                >
                    Export CSV
                </button>
            </div>

            <div className="overflow-x-auto bg-white dark:bg-gray-800 shadow rounded-lg">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-900">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Date</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Recipient</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Amount</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Token</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                        {mockStreams.map((stream) => (
                            <tr key={stream.id}>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">{stream.date}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 font-mono">{stream.recipient}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">{stream.amount}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{stream.token}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm">
                                    <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full 
                    ${stream.status === 'Active' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                                            stream.status === 'Completed' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                                                'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                                        {stream.status}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default Dashboard;
