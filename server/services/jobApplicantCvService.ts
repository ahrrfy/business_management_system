import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  jobApplicantCvFiles,
  jobApplicants,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import type { CompanyBranchScope } from "./companyBranchScope";
import { requireDb } from "./tx";

export const MAX_CV_BYTES = 2 * 1024 * 1024;
export const MAX_CV_BASE64_CHARS = Math.ceil(MAX_CV_BYTES / 3) * 4;
export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
const DOCX_MAIN_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

export type JobApplicantCvUploadInput = {
  fileName: string;
  mimeType: string;
  base64: string;
};

export type PreparedJobApplicantCv = {
  publicKey: string;
  fileName: string;
  mimeType: typeof PDF_MIME | typeof DOCX_MIME;
  sizeBytes: number;
  bytes: Buffer;
};

type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

function badCv(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** Decode only canonical base64. Buffer.from() alone silently accepts junk and whitespace. */
export function decodeStrictBase64(value: string): Buffer {
  if (!value || value.length > MAX_CV_BASE64_CHARS || value.length % 4 !== 0 || !STRICT_BASE64_RE.test(value)) {
    return badCv("بيانات ملف السيرة الذاتية غير صالحة");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > MAX_CV_BYTES || bytes.toString("base64") !== value) {
    return badCv("حجم السيرة الذاتية يجب ألا يتجاوز 2MB");
  }
  return bytes;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = 22;
  const earliest = Math.max(0, bytes.length - minimum - 0xffff);
  for (let offset = bytes.length - minimum; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

/** Parse the ZIP central directory without extracting arbitrary archive paths. */
function parseZipEntries(bytes: Buffer): Map<string, ZipEntry> {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) {
    return badCv("ملف DOCX غير صالح");
  }
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) return badCv("ملف DOCX غير صالح");

  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount < 3 ||
    entryCount > 2048 ||
    centralOffset + centralSize > eocd
  ) {
    return badCv("بنية ملف DOCX غير مدعومة");
  }

  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) {
      return badCv("فهرس ملف DOCX تالف");
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (nameLength < 1 || end > eocd || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      return badCv("بنية ZIP64 غير مسموحة للسيرة الذاتية");
    }
    if ((flags & 0x0001) !== 0) return badCv("ملف DOCX المشفر غير مسموح");
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replaceAll("\\", "/");
    if (!name || name.includes("\0") || entries.has(name)) return badCv("أسماء مكونات DOCX غير صالحة");
    entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) return badCv("حجم فهرس DOCX غير متطابق");
  return entries;
}

function readZipEntry(bytes: Buffer, entry: ZipEntry, maxOutputLength: number): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) {
    return badCv("مكوّن DOCX غير صالح");
  }
  const flags = bytes.readUInt16LE(offset + 6);
  const method = bytes.readUInt16LE(offset + 8);
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if ((flags & 0x0001) !== 0 || method !== entry.method || dataEnd > bytes.length) {
    return badCv("مكوّن DOCX غير صالح");
  }
  const compressed = bytes.subarray(dataStart, dataEnd);
  let output: Buffer;
  try {
    if (method === 0) output = Buffer.from(compressed);
    else if (method === 8) output = inflateRawSync(compressed, { maxOutputLength });
    else return badCv("طريقة ضغط DOCX غير مدعومة");
  } catch {
    return badCv("تعذّر قراءة بنية DOCX");
  }
  if (output.length !== entry.uncompressedSize || output.length > maxOutputLength) {
    return badCv("حجم مكوّن DOCX غير متطابق");
  }
  return output;
}

function assertDocx(bytes: Buffer): void {
  const entries = parseZipEntries(bytes);
  const required = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"];
  for (const name of required) {
    if (!entries.has(name)) return badCv("الملف ZIP ليس مستند DOCX صالحاً");
  }
  for (const name of Array.from(entries.keys())) {
    const lower = name.toLowerCase();
    if (lower === "word/vbaproject.bin" || lower.endsWith(".docm")) {
      return badCv("ملفات DOCM والماكرو غير مسموحة");
    }
  }
  const contentTypesEntry = entries.get("[Content_Types].xml")!;
  const contentTypes = readZipEntry(bytes, contentTypesEntry, 256 * 1024).toString("utf8").toLowerCase();
  if (
    !contentTypes.includes(DOCX_MAIN_CONTENT_TYPE) ||
    contentTypes.includes("macroenabled") ||
    contentTypes.includes("vbaproject")
  ) {
    return badCv("يسمح بمستند DOCX عادي فقط، بلا DOCM أو ماكرو");
  }
}

function extensionOf(fileName: string): ".pdf" | ".docx" | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return ".pdf";
  if (lower.endsWith(".docx")) return ".docx";
  return null;
}

/** Original names are display-only; paths, controls and header metacharacters are stripped. */
export function sanitizeCvFileName(original: string, extension?: ".pdf" | ".docx"): string {
  const base = original.split(/[\\/]/).pop()?.normalize("NFC") ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"|?*;]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const ext = extension ?? extensionOf(clean) ?? ".pdf";
  if (!clean) return `cv${ext}`;
  return extensionOf(clean) ? clean : `${clean}${ext}`;
}

export function prepareJobApplicantCv(input: JobApplicantCvUploadInput): PreparedJobApplicantCv {
  if (!input || typeof input.fileName !== "string" || typeof input.mimeType !== "string" || typeof input.base64 !== "string") {
    return badCv("بيانات السيرة الذاتية غير مكتملة");
  }
  const extension = extensionOf(input.fileName.trim());
  if (!extension) return badCv("يسمح بملفات PDF وDOCX فقط");
  const bytes = decodeStrictBase64(input.base64);

  let mimeType: typeof PDF_MIME | typeof DOCX_MIME;
  if (extension === ".pdf") {
    if (input.mimeType !== PDF_MIME || !bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      return badCv("محتوى الملف لا يطابق PDF");
    }
    mimeType = PDF_MIME;
  } else {
    if (input.mimeType !== DOCX_MIME) return badCv("نوع ملف DOCX غير صالح");
    assertDocx(bytes);
    mimeType = DOCX_MIME;
  }

  return {
    publicKey: randomBytes(32).toString("base64url"),
    fileName: sanitizeCvFileName(input.fileName, extension),
    mimeType,
    sizeBytes: bytes.length,
    bytes,
  };
}

export async function insertPreparedJobApplicantCv(
  tx: Tx,
  applicantId: number,
  cv: PreparedJobApplicantCv,
): Promise<void> {
  await tx.insert(jobApplicantCvFiles).values({
    applicantId,
    publicKey: cv.publicKey,
    fileName: cv.fileName,
    mimeType: cv.mimeType,
    sizeBytes: cv.sizeBytes,
    bytes: cv.bytes,
  });
}

/** Random keys prevent enumeration; persisted applicant ownership enforces branch access. */
export async function getJobApplicantCvByKey(publicKey: string, scope: CompanyBranchScope) {
  if (!PUBLIC_KEY_RE.test(publicKey)) return null;
  const db = requireDb();
  const branch = scope.branchId == null ? undefined : eq(jobApplicants.branchId, scope.branchId);
  const [file] = await db
    .select({
      publicKey: jobApplicantCvFiles.publicKey,
      fileName: jobApplicantCvFiles.fileName,
      mimeType: jobApplicantCvFiles.mimeType,
      sizeBytes: jobApplicantCvFiles.sizeBytes,
      bytes: jobApplicantCvFiles.bytes,
    })
    .from(jobApplicantCvFiles)
    .innerJoin(jobApplicants, eq(jobApplicants.id, jobApplicantCvFiles.applicantId))
    .where(branch ? and(eq(jobApplicantCvFiles.publicKey, publicKey), branch) : eq(jobApplicantCvFiles.publicKey, publicKey))
    .limit(1);
  return file ?? null;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildCvDownloadHeaders(file: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): Record<string, string> {
  const contentType = file.mimeType === PDF_MIME || file.mimeType === DOCX_MIME
    ? file.mimeType
    : "application/octet-stream";
  const downloadExtension = contentType === PDF_MIME
    ? ".pdf"
    : contentType === DOCX_MIME
      ? ".docx"
      : ".bin";
  // Stored metadata is not trusted at response time: the final extension follows
  // the allowlisted MIME (or .bin), never an attacker-controlled stored suffix.
  const sanitized = sanitizeCvFileName(file.fileName, downloadExtension === ".docx" ? ".docx" : ".pdf");
  const safeName = `${sanitized.replace(/\.(?:pdf|docx)$/i, "")}${downloadExtension}`;
  return {
    "Content-Type": contentType,
    "Content-Length": String(file.sizeBytes),
    "Content-Disposition": `attachment; filename="candidate-cv${downloadExtension}"; filename*=UTF-8''${encodeRfc5987(safeName)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}
