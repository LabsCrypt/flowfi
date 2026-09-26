import { Suspense } from "react";
import { WalletEntry } from "@/components/wallet/wallet-entry";

export default function AppDashboardPage() {
  return (
    <Suspense>
      <WalletEntry />
    </Suspense>
  );
}
