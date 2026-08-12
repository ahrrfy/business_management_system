import { describe, expect, it } from "vitest";
import {
  buildCvDownloadHeaders,
  DOCX_MIME,
  PDF_MIME,
} from "../../services/jobApplicantCvService";

describe("CV download headers", () => {
  it("always forces PDF to download and disables sniffing/caching", () => {
    const headers = buildCvDownloadHeaders({ fileName: "سيرة أحمد.pdf", mimeType: PDF_MIME, sizeBytes: 1234 });
    expect(headers["Content-Type"]).toBe(PDF_MIME);
    expect(headers["Content-Disposition"]).toMatch(/^attachment;/);
    expect(headers["Content-Disposition"]).toContain("filename*=UTF-8''");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["Content-Length"]).toBe("1234");
  });

  it("keeps DOCX as an attachment and neutralizes header metacharacters", () => {
    const headers = buildCvDownloadHeaders({
      fileName: "../../evil\";name.docx",
      mimeType: DOCX_MIME,
      sizeBytes: 42,
    });
    expect(headers["Content-Disposition"]).toMatch(/^attachment; filename="candidate-cv\.docx";/);
    expect(headers["Content-Disposition"]).not.toContain("../");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("fails closed to octet-stream if stored metadata is ever corrupted", () => {
    const headers = buildCvDownloadHeaders({ fileName: "payload.html", mimeType: "text/html", sizeBytes: 10 });
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Content-Disposition"]).toMatch(/^attachment; filename="candidate-cv\.bin";/);
    expect(headers["Content-Disposition"]).toContain("payload.html.bin");
    expect(headers["Content-Disposition"]).not.toMatch(/\.html(?:"|$)/);
  });
});
