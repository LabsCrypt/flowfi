/**
 * lib/clipboard.ts
 *
 * Shared clipboard helper with consistent toast feedback and error handling.
 *
 * `navigator.clipboard.writeText` can reject (or be entirely unavailable —
 * e.g. insecure context, denied permission, unsupported browser). This
 * wrapper normalizes both cases into a single non-throwing call so callers
 * never need their own try/catch.
 */

import toast from "react-hot-toast";

export interface CopyToClipboardOptions {
  /** Message shown in the success toast. Defaults to "Copied to clipboard". */
  successMessage?: string;
  /** Message shown in the error toast. Defaults to "Failed to copy to clipboard". */
  errorMessage?: string;
}

/**
 * Copies `text` to the clipboard, surfacing a success or error toast.
 *
 * Never throws — resolves to `true` on success and `false` on failure
 * (including when the Clipboard API is unavailable).
 */
export async function copyToClipboard(
  text: string,
  options?: CopyToClipboardOptions,
): Promise<boolean> {
  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== "function"
    ) {
      throw new Error("Clipboard API unavailable");
    }

    await navigator.clipboard.writeText(text);
    toast.success(options?.successMessage ?? "Copied to clipboard");
    return true;
  } catch {
    toast.error(options?.errorMessage ?? "Failed to copy to clipboard");
    return false;
  }
}
