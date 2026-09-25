import { describe, it, expect } from "vitest";
import { redactDiagnostics, createDiagnosticsExport } from "./diagnostics";

describe("diagnostics", () => {
  it("redacts sensitive values", () => {
    const result = redactDiagnostics({
      name: "test",
      password: "secret123",
      apiKey: "abc123",
      nested: {
        privateKey: "very-secret",
      },
    });

    expect(result).toEqual({
      name: "test",
      password: "[REDACTED]",
      apiKey: "[REDACTED]",
      nested: {
        privateKey: "[REDACTED]",
      },
    });
  });

  it("creates a redacted JSON export", () => {
    const result = createDiagnosticsExport({
      status: "error",
      accessToken: "secret-token",
      message: "Something went wrong",
    });

    expect(result).toContain('"accessToken": "[REDACTED]"');
    expect(result).toContain('"message": "Something went wrong"');
    expect(result).not.toContain("secret-token");
  });
});
