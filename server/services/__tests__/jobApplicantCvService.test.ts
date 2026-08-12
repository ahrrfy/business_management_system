import { describe, expect, it } from "vitest";
import {
  DOCX_MIME,
  MAX_CV_BYTES,
  PDF_MIME,
  prepareJobApplicantCv,
  sanitizeCvFileName,
} from "../jobApplicantCvService";

type ZipPart = { name: string; bytes: Buffer };

/** Minimal stored ZIP builder; sufficient to exercise the DOCX central-directory validator. */
function storedZip(parts: ZipPart[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(part.bytes.length, 18);
    local.writeUInt32LE(part.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, part.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(part.bytes.length, 20);
    central.writeUInt32LE(part.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + part.bytes.length;
  }

  const centralBytes = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralBytes, eocd]);
}

function docx(contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", extras: ZipPart[] = []) {
  return storedZip([
    {
      name: "[Content_Types].xml",
      bytes: Buffer.from(`<Types><Override PartName="/word/document.xml" ContentType="${contentType}"/></Types>`),
    },
    { name: "_rels/.rels", bytes: Buffer.from("<Relationships/>") },
    { name: "word/document.xml", bytes: Buffer.from("<document/>") },
    ...extras,
  ]);
}

describe("job applicant CV validation", () => {
  it("accepts a PDF only when extension, declared MIME and magic bytes agree", () => {
    const bytes = Buffer.from("%PDF-1.7\n%%EOF", "ascii");
    const prepared = prepareJobApplicantCv({
      fileName: "C:\\fakepath\\سيرة أحمد.pdf",
      mimeType: PDF_MIME,
      base64: bytes.toString("base64"),
    });
    expect(prepared.mimeType).toBe(PDF_MIME);
    expect(prepared.fileName).toBe("سيرة أحمد.pdf");
    expect(prepared.bytes.equals(bytes)).toBe(true);
    expect(prepared.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("accepts a structurally minimal, macro-free DOCX", () => {
    const bytes = docx();
    const prepared = prepareJobApplicantCv({
      fileName: "candidate.docx",
      mimeType: DOCX_MIME,
      base64: bytes.toString("base64"),
    });
    expect(prepared.mimeType).toBe(DOCX_MIME);
    expect(prepared.sizeBytes).toBe(bytes.length);
  });

  it("rejects non-canonical base64 instead of letting Buffer silently ignore junk", () => {
    expect(() => prepareJobApplicantCv({
      fileName: "cv.pdf",
      mimeType: PDF_MIME,
      base64: `${Buffer.from("%PDF-x").toString("base64")}\n`,
    })).toThrow(/غير صالحة/);
  });

  it("rejects a decoded payload larger than 2MB", () => {
    const tooLarge = Buffer.alloc(MAX_CV_BYTES + 1, 0x41).toString("base64");
    expect(() => prepareJobApplicantCv({ fileName: "cv.pdf", mimeType: PDF_MIME, base64: tooLarge })).toThrow(/2MB|غير صالحة/);
  });

  it("rejects extension/MIME/magic spoofing and an arbitrary ZIP renamed to DOCX", () => {
    const pdf = Buffer.from("%PDF-1.7");
    expect(() => prepareJobApplicantCv({ fileName: "cv.docx", mimeType: DOCX_MIME, base64: pdf.toString("base64") })).toThrow();
    expect(() => prepareJobApplicantCv({ fileName: "cv.pdf", mimeType: DOCX_MIME, base64: pdf.toString("base64") })).toThrow(/PDF/);
    const zip = storedZip([
      { name: "a.txt", bytes: Buffer.from("a") },
      { name: "b.txt", bytes: Buffer.from("b") },
      { name: "c.txt", bytes: Buffer.from("c") },
    ]);
    expect(() => prepareJobApplicantCv({ fileName: "cv.docx", mimeType: DOCX_MIME, base64: zip.toString("base64") })).toThrow(/DOCX/);
  });

  it("rejects DOCM content types and embedded VBA even with a .docx name", () => {
    const macroContentType = "application/vnd.ms-word.document.macroEnabled.main+xml";
    expect(() => prepareJobApplicantCv({
      fileName: "cv.docx",
      mimeType: DOCX_MIME,
      base64: docx(macroContentType).toString("base64"),
    })).toThrow(/DOCM|ماكرو/);
    expect(() => prepareJobApplicantCv({
      fileName: "cv.docx",
      mimeType: DOCX_MIME,
      base64: docx(undefined, [{ name: "word/vbaProject.bin", bytes: Buffer.from("macro") }]).toString("base64"),
    })).toThrow(/DOCM|ماكرو/);
  });

  it("sanitizes path and header-control characters for display only", () => {
    expect(sanitizeCvFileName("../../bad\r\n\u202ename;\".pdf")).toBe("badname__.pdf");
  });
});
