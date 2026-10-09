/**
 * Pure helpers for the TokenAvatar fallback (#1490): deterministic gradient
 * derivation from a token address and initials extraction from a symbol.
 *
 * Everything here must be deterministic (no Math.random / Date) so the server
 * and client render identical markup and a token keeps its colours everywhere.
 */

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

export interface TokenGradientStops {
  angle: number;
  from: HslColor;
  to: HslColor;
}

/** WCAG AA contrast required for the white initials on both gradient stops. */
export const MIN_INITIALS_CONTRAST = 4.5;

const SATURATION = 65;
/** Lightest the first stop may be; darker values are used when contrast requires it. */
const MAX_LIGHTNESS = 50;
/** How much darker the second stop is than its own safe lightness, for depth. */
const SECOND_STOP_DARKEN = 8;
const MIN_LIGHTNESS = 15;

/** Neutral slate gradient used when neither an address nor a symbol is known. */
export const DEFAULT_TOKEN_GRADIENT_STOPS: TokenGradientStops = {
  angle: 135,
  from: { h: 215, s: 20, l: 40 },
  to: { h: 215, s: 25, l: 27 },
};

/** 32-bit FNV-1a hash of a string. Stable across runtimes. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Converts HSL (h in degrees, s/l in percent) to sRGB channels in [0, 1]. */
export function hslToRgb({ h, s, l }: HslColor): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** WCAG 2.x relative luminance of an HSL colour. */
export function relativeLuminance(color: HslColor): number {
  const [r, g, b] = hslToRgb(color).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of white text on the given background colour. */
export function whiteContrastRatio(background: HslColor): number {
  return 1.05 / (relativeLuminance(background) + 0.05);
}

/**
 * Returns the lightest integer lightness (<= MAX_LIGHTNESS) at which white text
 * on hsl(hue, SATURATION, l) meets MIN_INITIALS_CONTRAST. Yellows and greens
 * are perceptually brighter than blues, so they end up darker.
 */
function safeLightness(hue: number): number {
  for (let l = MAX_LIGHTNESS; l > MIN_LIGHTNESS; l--) {
    if (whiteContrastRatio({ h: hue, s: SATURATION, l }) >= MIN_INITIALS_CONTRAST) {
      return l;
    }
  }
  return MIN_LIGHTNESS;
}

function normalizeSeed(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/**
 * Derives the gradient stops for a token. The address is the primary seed; the
 * symbol is used when no address is available, and a neutral default when
 * neither is.
 */
export function getTokenGradientStops(
  address?: string | null,
  fallbackSeed?: string | null,
): TokenGradientStops {
  const seed = normalizeSeed(address) || normalizeSeed(fallbackSeed);
  if (!seed) return DEFAULT_TOKEN_GRADIENT_STOPS;

  const hash = hashString(seed);
  const fromHue = hash % 360;
  const toHue = (fromHue + 30 + ((hash >>> 9) % 60)) % 360;
  const angle = 135 + ((hash >>> 18) % 4) * 15;

  return {
    angle,
    from: { h: fromHue, s: SATURATION, l: safeLightness(fromHue) },
    to: {
      h: toHue,
      s: SATURATION,
      l: Math.max(MIN_LIGHTNESS, safeLightness(toHue) - SECOND_STOP_DARKEN),
    },
  };
}

function toCssHsl({ h, s, l }: HslColor): string {
  return `hsl(${h}, ${s}%, ${l}%)`;
}

/** CSS `linear-gradient(...)` for a token, deterministic in its address. */
export function getTokenGradient(
  address?: string | null,
  fallbackSeed?: string | null,
): string {
  const { angle, from, to } = getTokenGradientStops(address, fallbackSeed);
  return `linear-gradient(${angle}deg, ${toCssHsl(from)}, ${toCssHsl(to)})`;
}

function splitGraphemes(value: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      (part) => part.segment,
    );
  }
  // Array.from splits by code point, so surrogate pairs (most emoji) stay whole.
  return Array.from(value);
}

/**
 * First two characters of a token symbol, trimmed and uppercased, without
 * splitting emoji or other multi-code-unit characters. Returns "?" when empty.
 */
export function getTokenInitials(symbol?: string | null): string {
  const trimmed = (symbol ?? "").trim();
  if (!trimmed) return "?";
  return splitGraphemes(trimmed).slice(0, 2).join("").toUpperCase();
}
