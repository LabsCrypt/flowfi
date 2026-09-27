"use client";

import { Globe2 } from "lucide-react";
import { useNetwork } from "@/context/NetworkContext";
import type { NetworkId } from "@/lib/stellar-config";

const colors: Record<NetworkId, string> = { testnet: "bg-orange-400", futurenet: "bg-cyan-400", mainnet: "bg-emerald-400", sandbox: "bg-purple-400" };
const labels: Record<NetworkId, string> = { testnet: "Testnet", futurenet: "Futurenet", mainnet: "Mainnet", sandbox: "Sandbox" };
export function NetworkSelector() { const { networkId, setNetworkId } = useNetwork(); return <label className="flex items-center gap-2 text-xs text-slate-400"><Globe2 size={15} /><span className={`h-2 w-2 rounded-full ${colors[networkId]}`} /><select aria-label="Active Stellar network" value={networkId} onChange={(event) => setNetworkId(event.target.value as NetworkId)} className="bg-transparent text-xs font-semibold text-slate-200 outline-none">{(Object.keys(labels) as NetworkId[]).map((id) => <option key={id} value={id}>{labels[id]}</option>)}</select></label>; }