import { ActivityHistory } from './dashboard/ActivityHistory';
import { fetchUserEvents } from '@/lib/dashboard';
import { useWallet } from '@/context/wallet-context';
import { BackendStreamEvent } from '@/lib/api-types';

interface StreamData extends Record<string, unknown> {
    id: string;
    date: string;
    recipient: string;
    amount: number;
    token: string;
    status: 'Active' | 'Completed' | 'Cancelled';
    deposited: number;
    withdrawn: number;
}

const mockStreams: StreamData[] = [
    { id: '1', date: '2023-10-25', recipient: 'G...ABCD', amount: 500, token: 'USDC', status: 'Completed', deposited: 500, withdrawn: 500 },
    { id: '2', date: '2023-10-26', recipient: 'G...EFGH', amount: 1200, token: 'XLM', status: 'Active', deposited: 1200, withdrawn: 600 },
    { id: '3', date: '2023-10-27', recipient: 'G...IJKL', amount: 300, token: 'EURC', status: 'Cancelled', deposited: 300, withdrawn: 150 },
    { id: '4', date: '2023-10-28', recipient: 'G...MNOP', amount: 1000, token: 'USDC', status: 'Completed', deposited: 1000, withdrawn: 1000 },
    { id: '5', date: '2023-10-29', recipient: 'G...QRST', amount: 750, token: 'USDC', status: 'Active', deposited: 750, withdrawn: 250 },
];

const Dashboard: React.FC = () => {
    const { session } = useWallet();
    const [activeTab, setActiveTab] = React.useState<'streams' | 'activity'>('streams');
    const [events, setEvents] = React.useState<BackendStreamEvent[]>([]);
    const [isLoadingEvents, setIsLoadingEvents] = React.useState(false);

    React.useEffect(() => {
        if (activeTab === 'activity' && session?.publicKey) {
            loadEvents();
        }
    }, [activeTab, session?.publicKey]);

    const loadEvents = async () => {
        if (!session?.publicKey) return;
        setIsLoadingEvents(true);
        try {
            const data = await fetchUserEvents(session.publicKey);
            setEvents(data);
        } catch (error) {
            console.error(error);
        } finally {
            setIsLoadingEvents(false);
        }
    };

    const handleExport = () => {
        downloadCSV(mockStreams, 'flowfi-stream-history.csv');
    };

    const handleTopUp = (streamId: string) => {
        const amount = prompt(`Enter amount to add to stream ${streamId}:`);
        if (amount && parseFloat(amount) > 0) {
            console.log(`Adding ${amount} funds to stream ${streamId}`);
            // TODO: Integrate with Soroban contract's top_up_stream function
            alert(`Successfully added ${amount} to stream ${streamId}`);
        }
    };

    return (
        <div className="p-8">
            <div className="flex justify-between items-center mb-6">
                <div className="flex items-center gap-6">
                    <button
                        onClick={() => setActiveTab('streams')}
                        className={`text-2xl font-bold transition-colors ${activeTab === 'streams' ? 'text-gray-800 dark:text-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'}`}
                    >
                        Stream History
                    </button>
                    <button
                        onClick={() => setActiveTab('activity')}
                        className={`text-2xl font-bold transition-colors ${activeTab === 'activity' ? 'text-gray-800 dark:text-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'}`}
                    >
                        Activity
                    </button>
                </div>
                {activeTab === 'streams' && (
                    <button
                        onClick={handleExport}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded shadow transition-colors"
                    >
                        Export CSV
                    </button>
                )}
            </div>

            {activeTab === 'streams' ? (
                <div className="overflow-x-auto bg-white dark:bg-gray-800 shadow rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Date</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Recipient</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Deposited</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Withdrawn</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Token</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {mockStreams.map((stream) => (
                                <tr key={stream.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">{stream.date}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 font-mono">{stream.recipient}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 font-semibold">{stream.deposited} {stream.token}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{stream.withdrawn} {stream.token}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{stream.token}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full
                        ${stream.status === 'Active' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                                                stream.status === 'Completed' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                                                    'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                                            {stream.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                        {stream.status === 'Active' && (
                                            <button
                                                onClick={() => handleTopUp(stream.id)}
                                                className="text-green-600 hover:text-green-900 dark:text-green-400 dark:hover:text-green-300 bg-green-50 dark:bg-green-900/20 px-3 py-1 rounded-md transition-colors font-semibold"
                                            >
                                                Add Funds
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <ActivityHistory events={events} isLoading={isLoadingEvents} />
            )}
        </div>
    );
};

export default Dashboard;
