// Issue #1661: Add tabular-nums styling and polite screen-reader attributes

import React, { useEffect, useRef, useState } from 'react';

interface ClaimableTickerProps {
  baseBalance: number;
  tokenSymbol?: string;
  decimals?: number;
}

/**
 * High-frequency balance ticker with accessibility improvements:
 * - tabular-nums prevents digit width jitter
 * - aria-live="off" prevents 60fps screen reader flood
 * - Static aria-label provides clean screen reader experience
 */
export function ClaimableTicker({ 
  baseBalance, 
  tokenSymbol = 'TOKEN',
  decimals = 7 
}: ClaimableTickerProps) {
  const [displayBalance, setDisplayBalance] = useState(baseBalance);
  const animationRef = useRef<number>();

  useEffect(() => {
    let currentBalance = baseBalance;
    const tickRate = 1000 / 60; // 60fps

    const tick = () => {
      currentBalance += 0.0001; // Simulated accrual
      setDisplayBalance(currentBalance);
      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [baseBalance]);

  const formattedBalance = displayBalance.toFixed(decimals);

  return (
    <div 
      style={{ fontVariantNumeric: 'tabular-nums' }}
      aria-label={`${baseBalance.toFixed(decimals)} ${tokenSymbol} available`}
    >
      {/* High-frequency animated span with aria-live="off" to prevent screen reader flood */}
      <span aria-live="off">
        {formattedBalance} {tokenSymbol}
      </span>
      
      {/* Visually hidden static value for screen readers */}
      <span style={{ 
        position: 'absolute', 
        left: '-10000px', 
        width: '1px', 
        height: '1px', 
        overflow: 'hidden' 
      }}>
        Balance: {baseBalance.toFixed(decimals)} {tokenSymbol}
      </span>
    </div>
  );
}
