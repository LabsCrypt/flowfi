import Dashboard from "../components/Dashboard";

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-100 dark:bg-gray-900 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <Dashboard />
      </div>
    </main>
  );
}
