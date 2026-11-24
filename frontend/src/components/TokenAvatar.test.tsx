import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TokenAvatar } from "./TokenAvatar";
import { getTokenGradient } from "@/utils/tokenAvatar";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

// Failed URLs are remembered for the whole session (module scope), so every
// test uses its own URL to stay independent.
let urlCounter = 0;
const uniqueUrl = () => `https://logos.example/token-${++urlCounter}.png`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TokenAvatar", () => {
  it("renders the fallback without an <img> when there is no src", () => {
    const { container, rerender } = render(<TokenAvatar symbol="USDC" address={USDC} />);

    expect(screen.getByRole("img", { name: "USDC token logo" })).toHaveTextContent("US");
    expect(container.querySelector("img")).toBeNull();

    for (const src of [null, "", "   "]) {
      rerender(<TokenAvatar src={src} symbol="USDC" address={USDC} />);
      expect(container.querySelector("img")).toBeNull();
    }
  });

  it("renders the image when a src is provided", () => {
    const src = uniqueUrl();
    const { container } = render(<TokenAvatar src={src} symbol="USDC" address={USDC} />);

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", src);
    expect(img).toHaveAttribute("alt", "USDC token logo");
    // Keeps React SSR from adding an image preload (a second request on 404).
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("swaps the image for the fallback when it fails to load", () => {
    const { container } = render(<TokenAvatar src={uniqueUrl()} symbol="eurc" address={USDC} />);

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    const fallback = screen.getByRole("img", { name: "eurc token logo" });
    expect(fallback).toHaveTextContent("EU");
    expect(fallback.style.backgroundImage).toBe(getTokenGradient(USDC));
  });

  it("shows the fallback when the image already failed before hydration", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(new Error("broken"));

    const { container } = render(<TokenAvatar src={uniqueUrl()} symbol="USDC" address={USDC} />);

    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(screen.getByRole("img", { name: "USDC token logo" })).toHaveTextContent("US");
  });

  it("keeps a loaded image that merely has no intrinsic width (e.g. SVG)", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    const decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockResolvedValue(undefined);

    const { container } = render(<TokenAvatar src={uniqueUrl()} symbol="USDC" address={USDC} />);

    await waitFor(() => expect(decode).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("tries a new src again after a previous one failed", () => {
    const broken = uniqueUrl();
    const next = uniqueUrl();
    const { container, rerender } = render(
      <TokenAvatar src={broken} symbol="USDC" address={USDC} />,
    );

    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();

    rerender(<TokenAvatar src={next} symbol="USDC" address={USDC} />);
    expect(container.querySelector("img")).toHaveAttribute("src", next);
  });

  it("renders the fallback directly for a URL that already failed this session", () => {
    const src = uniqueUrl();
    const first = render(<TokenAvatar src={src} symbol="USDC" address={USDC} />);
    fireEvent.error(first.container.querySelector("img")!);
    first.unmount();

    const { container } = render(<TokenAvatar src={src} symbol="USDC" address={USDC} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "USDC token logo" })).toBeInTheDocument();
  });

  it("updates every avatar sharing a URL when that URL fails", () => {
    const src = uniqueUrl();
    const { container } = render(
      <>
        <TokenAvatar src={src} symbol="USDC" address={USDC} />
        <TokenAvatar src={src} symbol="USDC" address={USDC} />
      </>,
    );

    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByRole("img", { name: "USDC token logo" })).toHaveLength(2);
  });

  it("uses '?' for a missing symbol and a custom accessible name when given", () => {
    render(<TokenAvatar symbol="  " alt="Custom SAC token" />);
    expect(screen.getByRole("img", { name: "Custom SAC token" })).toHaveTextContent("?");
  });

  it("hides decorative avatars from assistive tech", () => {
    const src = uniqueUrl();
    const { container, rerender } = render(
      <TokenAvatar src={src} symbol="XLM" address={USDC} decorative />,
    );
    expect(container.querySelector("img")).toHaveAttribute("alt", "");

    rerender(<TokenAvatar symbol="XLM" address={USDC} decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("XL")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps identical dimensions for the image and the fallback", () => {
    const { container, rerender } = render(
      <TokenAvatar src={uniqueUrl()} symbol="USDC" address={USDC} size={40} />,
    );
    const img = container.querySelector("img")!;
    expect(img.style.width).toBe("40px");
    expect(img.style.height).toBe("40px");

    rerender(<TokenAvatar symbol="USDC" address={USDC} size={40} />);
    const fallback = screen.getByRole("img", { name: "USDC token logo" });
    expect(fallback.style.width).toBe("40px");
    expect(fallback.style.height).toBe("40px");
    expect(fallback.style.fontSize).toBe("16px");
  });
});
