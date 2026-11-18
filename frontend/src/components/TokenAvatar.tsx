"use client";

import { useCallback, useSyncExternalStore } from "react";
import { getTokenGradient, getTokenInitials } from "@/utils/tokenAvatar";

export interface TokenAvatarProps {
  /** Logo URL. Null, empty or whitespace renders the fallback without a request. */
  src?: string | null;
  symbol: string;
  /** Token contract address; seeds the deterministic fallback gradient. */
  address?: string | null;
  /** Diameter in pixels, applied to both the image and the fallback. */
  size?: number;
  className?: string;
  /** Accessible name. Defaults to "<SYMBOL> token logo". */
  alt?: string;
  /** Hide from assistive tech when the symbol is already shown as text next to it. */
  decorative?: boolean;
}

// Logo URLs that failed to load this session. Rendering the fallback directly
// for them avoids re-requesting (and re-logging a 404 for) the same URL.
const failedLogoUrls = new Set<string>();
const failedLogoListeners = new Set<() => void>();

function markLogoFailed(url: string) {
  if (failedLogoUrls.has(url)) return;
  failedLogoUrls.add(url);
  failedLogoListeners.forEach((listener) => listener());
}

function subscribeToFailedLogos(listener: () => void) {
  failedLogoListeners.add(listener);
  return () => {
    failedLogoListeners.delete(listener);
  };
}

function normalizeSrc(src: string | null | undefined): string | null {
  const trimmed = src?.trim();
  return trimmed ? trimmed : null;
}

export function TokenAvatar({
  src,
  symbol,
  address,
  size = 32,
  className,
  alt,
  decorative = false,
}: TokenAvatarProps) {
  const url = normalizeSrc(src);
  const hasFailed = useSyncExternalStore(
    subscribeToFailedLogos,
    () => url !== null && failedLogoUrls.has(url),
    // The server never observes load errors, so it always renders the <img>.
    () => false,
  );

  // With SSR the image can fail before React hydrates and attaches onError, so
  // the error event is lost. Detect that case once the element is attached.
  // naturalWidth is also 0 for SVGs without intrinsic dimensions in some
  // browsers, so confirm with decode(), which only rejects for broken images.
  const detectEarlyFailure = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img || url === null) return;
      if (!img.complete || img.naturalWidth !== 0) return;
      if (typeof img.decode === "function") {
        img.decode().catch(() => markLogoFailed(url));
      } else {
        markLogoFailed(url);
      }
    },
    [url],
  );

  const trimmedSymbol = symbol.trim();
  const label = alt ?? `${trimmedSymbol || "Unknown"} token logo`;
  const dimensions = { width: size, height: size };

  // A plain <img> is intentional: logo hosts are arbitrary third parties (not
  // enumerable in next.config images.remotePatterns), and next/image re-requests
  // the URL after hydration to replay lost errors, doubling failed requests.
  if (url !== null && !hasFailed) {
    return (
      <img
        key={url}
        ref={detectEarlyFailure}
        src={url}
        alt={decorative ? "" : label}
        width={size}
        height={size}
        // Lazy also stops React's SSR from emitting a <link rel="preload"> for
        // the logo; a failed preload isn't reused, so a broken URL would be
        // requested twice before hydration.
        loading="lazy"
        decoding="async"
        onError={() => markLogoFailed(url)}
        className={["inline-block shrink-0 rounded-full object-cover", className]
          .filter(Boolean)
          .join(" ")}
        style={dimensions}
      />
    );
  }

  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      className={[
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none text-white",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        ...dimensions,
        backgroundImage: getTokenGradient(address, trimmedSymbol),
        fontSize: Math.max(8, Math.round(size * 0.4)),
      }}
    >
      {getTokenInitials(symbol)}
    </span>
  );
}
