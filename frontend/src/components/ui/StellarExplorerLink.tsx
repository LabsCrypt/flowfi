"use client";

import { ExternalLink } from "lucide-react";
import { useNetwork } from "@/context/NetworkContext";

interface StellarExplorerLinkProps {
  type: "tx" | "contract" | "account";
  id: string;
  truncate?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function StellarExplorerLink({
  type,
  id,
  truncate = true,
  className = "",
  children,
}: StellarExplorerLinkProps) {
  const { networkId } = useNetwork();
  
  const url = `https://stellar.expert/explorer/${networkId}/${type}/${id}`;
  
  const displayText = children || (truncate ? shortenHash(id) : id);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-accent hover:text-accent/80 transition-colors ${className}`}
    >
      <span className="font-mono text-sm">{displayText}</span>
      <ExternalLink className="h-3 w-3 flex-shrink-0" />
    </a>
  );
}

function shortenHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-6)}`;
}
