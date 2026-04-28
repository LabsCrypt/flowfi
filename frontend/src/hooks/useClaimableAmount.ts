import { useState, useEffect, useRef } from "react";
import { getClaimableAmount } from "@/lib/api/streams";

interface UseClaimableAmountProps {
  streamId: string;
  initialClaimable: number;
  ratePerSecond: number;
  isActive: boolean;
  isPaused?: boolean;
}

export function useClaimableAmount({
  streamId,
  initialClaimable,
  ratePerSecond,
  isActive,
  isPaused
}: UseClaimableAmountProps) {
  const [claimable, setClaimable] = useState(initialClaimable);
  const [tick, setTick] = useState(0);
  
  // To keep track of the base amount and when we last synced
  const baseAmountRef = useRef(initialClaimable);
  const lastSyncTimeRef = useRef(Date.now());
  const rateRef = useRef(ratePerSecond);

  useEffect(() => {
    baseAmountRef.current = initialClaimable;
    lastSyncTimeRef.current = Date.now();
    rateRef.current = ratePerSecond;
    setClaimable(initialClaimable);
  }, [initialClaimable, ratePerSecond]);

  useEffect(() => {
    if (!isActive || isPaused) return;

    // Local tick every second
    const intervalId = setInterval(() => {
      const now = Date.now();
      const elapsedSeconds = (now - lastSyncTimeRef.current) / 1000;
      
      const currentClaimable = baseAmountRef.current + (rateRef.current * elapsedSeconds);
      setClaimable(currentClaimable);
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(intervalId);
  }, [isActive, isPaused]);

  // Periodic API resync every 30 seconds
  useEffect(() => {
    if (!isActive || isPaused) return;

    const syncIntervalId = setInterval(async () => {
      try {
        const data = await getClaimableAmount(streamId);
        baseAmountRef.current = data.claimable;
        rateRef.current = data.ratePerSecond;
        lastSyncTimeRef.current = Date.now();
        setClaimable(data.claimable);
      } catch (err) {
        console.error("Failed to sync claimable amount", err);
      }
    }, 30000);

    return () => clearInterval(syncIntervalId);
  }, [streamId, isActive, isPaused]);

  return { claimable, tick };
}
