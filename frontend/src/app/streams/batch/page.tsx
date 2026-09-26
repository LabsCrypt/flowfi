"use client";

import { useState } from "react";
import { BatchStreamWizard } from "@/components/stream-creation/BatchStreamWizard";

export default function BatchStreamPage() {
  const [token, setToken] = useState("USDC");

  return (
    <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
      <div className="max-w-6xl mx-auto">
        <BatchStreamWizard token={token} onTokenChange={setToken} />
      </div>
    </main>
  );
}
