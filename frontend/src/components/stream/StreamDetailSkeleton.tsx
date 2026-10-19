"use client";

export function StreamDetailSkeleton() {
  return (
    <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
      <div className="max-w-4xl mx-auto space-y-6" aria-label="Loading stream details" role="status">
        {/* Skeleton: Header */}
        <div className="flex items-center gap-4">
          <div className="h-9 w-9 rounded-lg bg-slate-800/60 animate-pulse" />
          <div className="space-y-2">
            <div className="h-3 w-24 rounded-full bg-slate-800/60 animate-pulse" />
            <div className="h-6 w-40 rounded-md bg-slate-800/60 animate-pulse" />
          </div>
          <div className="ml-auto h-7 w-20 rounded-full bg-slate-800/60 animate-pulse" />
        </div>

        {/* Skeleton: Liquid Visualizer */}
        <div className="glass-card p-4">
          <div className="h-4 w-32 rounded-md bg-slate-800/60 animate-pulse mb-3" />
          <div className="h-24 rounded-lg bg-slate-800/60 animate-pulse" />
        </div>

        {/* Skeleton: Stream Overview */}
        <div className="glass-card p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <SkeletonInfoRow />
              <SkeletonInfoRow />
              <SkeletonInfoRow />
            </div>
            <div className="space-y-4">
              <SkeletonInfoRow />
              <SkeletonInfoRow />
              <SkeletonInfoRow />
            </div>
          </div>
        </div>

        {/* Skeleton: Financial Overview - 3 stat cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SkeletonStatCard />
          <SkeletonStatCard />
          <SkeletonStatCard highlight />
        </div>

        {/* Skeleton: Progress Bar */}
        <div className="glass-card p-6">
          <div className="h-5 w-36 rounded-md bg-slate-800/60 animate-pulse mb-4" />
          <div className="h-3 rounded-full bg-slate-800/60 animate-pulse mb-3" />
          <div className="h-4 w-48 rounded-md bg-slate-800/60 animate-pulse" />
        </div>

        {/* Skeleton: Action Buttons */}
        <div className="glass-card p-6">
          <div className="h-5 w-20 rounded-md bg-slate-800/60 animate-pulse mb-4" />
          <div className="flex flex-wrap gap-3">
            <div className="h-10 w-28 rounded-xl bg-slate-800/60 animate-pulse" />
            <div className="h-10 w-24 rounded-xl bg-slate-800/60 animate-pulse" />
            <div className="h-10 w-24 rounded-xl bg-slate-800/60 animate-pulse" />
            <div className="h-10 w-24 rounded-xl bg-slate-800/60 animate-pulse" />
          </div>
        </div>

        {/* Skeleton: Event History */}
        <div className="glass-card p-6">
          <div className="h-5 w-32 rounded-md bg-slate-800/60 animate-pulse mb-4" />
          <div className="space-y-3">
            <SkeletonEventRow />
            <SkeletonEventRow />
            <SkeletonEventRow />
            <SkeletonEventRow />
          </div>
        </div>
      </div>
    </main>
  );
}

function SkeletonInfoRow() {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5">
      <div className="h-4 w-20 rounded-md bg-slate-800/60 animate-pulse" />
      <div className="h-4 w-32 rounded-md bg-slate-800/60 animate-pulse" />
    </div>
  );
}

function SkeletonStatCard({ highlight = false }: { highlight?: boolean }) {
  return (
    <div className={`glass-card p-4 ${highlight ? "border-accent/20" : ""}`}>
      <div className="h-3 w-20 rounded-full bg-slate-800/60 animate-pulse mb-2" />
      <div className="h-6 w-32 rounded-md bg-slate-800/60 animate-pulse" />
    </div>
  );
}

function SkeletonEventRow() {
  return (
    <div className="flex items-center gap-4 py-3 border-b border-white/5">
      <div className="h-8 w-8 rounded-full bg-slate-800/60 animate-pulse flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-24 rounded-md bg-slate-800/60 animate-pulse" />
        <div className="h-3 w-36 rounded-full bg-slate-800/60 animate-pulse" />
      </div>
      <div className="h-4 w-20 rounded-md bg-slate-800/60 animate-pulse" />
    </div>
  );
}
