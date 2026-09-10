import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadApplicantCv,
  fetchApplicantCv,
} from "./applicantCvDownload";

const VALID_KEY = "A".repeat(43);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchApplicantCv", () => {
  it("fetches inside the authenticated same-origin session and returns a safe PDF name", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Blob(["%PDF-test"], { type: "application/pdf" }), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
    );

    const result = await fetchApplicantCv(VALID_KEY, "أحمد / اختبار", fetcher);

    expect(fetcher).toHaveBeenCalledWith(`/api/hr/applicant-cv/${VALID_KEY}`, {
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept:
          "application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    });
    expect(result.filename).toBe("السيرة الذاتية - أحمد _ اختبار.pdf");
    expect(result.blob.size).toBeGreaterThan(0);
  });

  it("keeps DOCX downloads in the allowlisted type", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          new Blob(["docx"], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
          {
            status: 200,
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
          },
        ),
    );

    const result = await fetchApplicantCv(VALID_KEY, "مرشح", fetcher);
    expect(result.filename).toBe("السيرة الذاتية - مرشح.docx");
  });

  it("explains an expired application session instead of requesting basic-auth credentials", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(fetchApplicantCv(VALID_KEY, "مرشح", fetcher)).rejects.toThrow(
      /انتهت جلسة الدخول/,
    );
  });

  it("rejects invalid keys and unexpected response types before saving", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Blob(["html"]), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );

    await expect(
      fetchApplicantCv("../secret", "مرشح", fetcher),
    ).rejects.toThrow(/غير صالح/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fetchApplicantCv(VALID_KEY, "مرشح", fetcher)).rejects.toThrow(
      /نوع ملف غير مسموح/,
    );
  });

  it.each([
    ["empty", new Blob([], { type: "application/pdf" })],
    [
      "oversized",
      new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], {
        type: "application/pdf",
      }),
    ],
  ])("rejects an %s response body", async (_caseName, body) => {
    const fetcher = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
    );

    await expect(fetchApplicantCv(VALID_KEY, "مرشح", fetcher)).rejects.toThrow(
      /حجم ملف السيرة الذاتية المستلم غير صالح/,
    );
  });
});

describe("downloadApplicantCv", () => {
  it("downloads the authenticated response through a temporary Blob URL", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const anchor = { href: "", download: "", rel: "", click, remove };
    const createObjectURL = vi.fn(() => "blob:applicant-cv");
    const revokeObjectURL = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Blob(["%PDF-test"], { type: "application/pdf" }), {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          }),
      ),
    );
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal("window", {
      setTimeout: vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
    });

    await downloadApplicantCv(VALID_KEY, "سارة");

    expect(anchor).toMatchObject({
      href: "blob:applicant-cv",
      download: "السيرة الذاتية - سارة.pdf",
      rel: "noopener",
    });
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:applicant-cv");
  });
});
