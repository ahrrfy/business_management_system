import { describe, expect, it } from "vitest";
import { describeAiError } from "./aiProductError";

describe("describeAiError", () => {
  it("explains missing AI configuration without exposing provider details", () => {
    const result = describeAiError({
      data: { code: "PRECONDITION_FAILED" },
      message: "secret provider detail",
    });

    expect(result.title).toContain("غير مفعّل");
    expect(result.message).not.toContain("secret");
    expect(result.retryable).toBe(false);
  });

  it("offers retry for transient provider failures", () => {
    expect(describeAiError({ data: { code: "TIMEOUT" } }).retryable).toBe(true);
    expect(
      describeAiError({ data: { code: "TOO_MANY_REQUESTS" } }).retryable,
    ).toBe(true);
    expect(
      describeAiError({ data: { code: "INTERNAL_SERVER_ERROR" } }).retryable,
    ).toBe(true);
  });

  it("gives a corrective action for invalid input without showing raw errors", () => {
    const result = describeAiError({
      data: { code: "BAD_REQUEST" },
      message: "Invalid JSON payload with API key abc123",
    });

    expect(result.title).toContain("بيانات التوليد");
    expect(result.action).toContain("مسؤول النظام");
    expect(result.message).not.toContain("abc123");
    expect(result.retryable).toBe(false);
  });

  it("falls back safely for unknown errors", () => {
    const result = describeAiError({ message: "database password=secret" });

    expect(result.title).toContain("توليد محتوى المنتج");
    expect(result.message).not.toContain("database");
    expect(result.message).not.toContain("secret");
  });
});
