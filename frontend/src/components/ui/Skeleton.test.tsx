import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton } from "./Skeleton";

// Issue #1032 asks for a render test per exported skeleton *variant*
// asserting a row-count prop controls the number of rendered placeholder
// elements (e.g. a StreamListSkeleton with a `rows` prop). As of this
// change, Skeleton.tsx exports exactly one component — a single
// className-only placeholder `<div>` with no row-count prop and no other
// variants (StreamListSkeleton or otherwise) anywhere in the codebase.
// There is nothing matching that description to test without inventing a
// multi-variant API that doesn't exist today, so this covers the actual
// single export instead.
describe("Skeleton", () => {
  it("renders a single placeholder element", () => {
    const { container } = render(<Skeleton />);
    expect(container.children).toHaveLength(1);
  });

  it("applies the pulse/placeholder styling by default", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("rounded-md");
  });

  it("merges a custom className with the default styling", () => {
    const { container } = render(<Skeleton className="h-4 w-full" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("h-4");
    expect(el.className).toContain("w-full");
  });

  it("renders with no className without erroring", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).not.toBeNull();
  });
});
