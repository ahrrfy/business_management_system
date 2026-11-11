import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fingerprint } from "./backup-publication.mjs";

const explicitFields = new Set(["fileUrl", "fileKey", "cvFileKey", "imageUrl"]);
const mediaFields = {
  assetDocuments: ["dataUrl"],
  productImages: ["url", "objectKey", "originalKey", "thumbDataUrl"],
  productImageJobs: ["originalObjectKey", "processedObjectKey", "processedUrl"],
  workOrderImages: ["url"],
};
const objectKey = /^single\/(?:studio|storefront-customizer)\/[A-Za-z0-9._/-]+\/([a-f0-9]{64})\.[a-z0-9]+$/;
const maxMirrorObjects = 6000;
const maxMirrorBytes = 1024 ** 3;

function identifier(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw Error("INVALID_ATTACHMENT_IDENTIFIER");
  return "`" + name + "`";
}

function isAttachmentColumn(table, column) {
  return /(?:AttachmentUrl|DocumentUrl)$/i.test(column) ||
    explicitFields.has(column) ||
    Object.hasOwn(mediaFields, table) && mediaFields[table].includes(column);
}

// Check decoded length, format markers and the file terminator where applicable.
const inlineSql = `CASE LOWER(header)
  WHEN 'data:image/jpeg;base64' THEN HEX(LEFT(bytes,3))='FFD8FF' AND HEX(RIGHT(bytes,2))='FFD9'
  WHEN 'data:image/png;base64' THEN HEX(LEFT(bytes,8))='89504E470D0A1A0A' AND HEX(RIGHT(bytes,12))='0000000049454E44AE426082'
  WHEN 'data:image/webp;base64' THEN LEFT(bytes,4)='RIFF' AND SUBSTRING(bytes,9,4)='WEBP'
    AND OCTET_LENGTH(bytes)=8+ORD(SUBSTRING(bytes,5,1))+256*ORD(SUBSTRING(bytes,6,1))+65536*ORD(SUBSTRING(bytes,7,1))+16777216*ORD(SUBSTRING(bytes,8,1))
  WHEN 'data:image/gif;base64' THEN LEFT(bytes,6) IN ('GIF87a','GIF89a') AND HEX(RIGHT(bytes,1))='3B'
  WHEN 'data:application/pdf;base64' THEN LEFT(bytes,5)='%PDF-' AND INSTR(RIGHT(bytes,1024),'%%EOF')>0
  ELSE 0 END`;

async function mirrorRoot(mirror) {
  if (!path.isAbsolute(mirror) || /^(?:\\\\|\/\/)/.test(mirror)) throw Error("LOCAL_ATTACHMENT_MIRROR_REQUIRED");
  const root = path.basename(mirror) === "objects" ? mirror : path.join(mirror, "objects");
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || path.relative(path.resolve(root), await realpath(root))) {
    throw Error("LOCAL_ATTACHMENT_MIRROR_REQUIRED");
  }
  return path.resolve(root);
}

export async function verifyRecoveryAttachments(sql, columns, mirror) {
  const summary = { scope: "KNOWN_FILE_REFERENCES_V1", references: 0, inlineVerified: 0, mirroredVerified: 0 };
  const root = mirror ? await mirrorRoot(mirror) : null;
  const verified = new Map();
  let hashedBytes = 0;

  async function checkObject(key) {
    if (verified.has(key)) return verified.get(key);
    const match = objectKey.exec(key);
    if (!match || key.includes("..") || key.includes("//") || verified.size >= maxMirrorObjects) return false;
    const file = path.join(root, ...key.split("/"));
    let ok = false;
    try {
      const metadata = await lstat(file);
      if (metadata.isFile() && metadata.size > 0 && metadata.size <= 25 * 1024 ** 2 &&
          hashedBytes + metadata.size <= maxMirrorBytes && !path.relative(file, await realpath(file))) {
        hashedBytes += metadata.size;
        const actual = await fingerprint(file);
        ok = actual.size === metadata.size && actual.sha256 === match[1];
      }
    } catch {
      // Missing, unreadable and redirected paths remain unverified.
    }
    verified.set(key, ok);
    return ok;
  }

  const hasProductKeys = columns.some(([table, column]) => table === "productImages" && column === "objectKey");
  for (const [table, column] of columns) {
    if (!isAttachmentColumn(table, column)) continue;
    const field = identifier(column);
    const legacyUrl = table === "productImages" && column === "url" && hasProductKeys
      ? " AND (`objectKey` IS NULL OR `objectKey`='')" : "";
    const from = `FROM ${identifier(table)} WHERE ${field} IS NOT NULL AND ${field}<>''${legacyUrl}`;
    const [references, inlineVerified] = sql(`
      SELECT COUNT(*),COALESCE(SUM(${inlineSql}),0) FROM (
        SELECT SUBSTRING_INDEX(${field}, ',', 1) AS header,
          CASE WHEN ${field} LIKE 'data:%;base64,%'
            THEN FROM_BASE64(SUBSTRING(${field}, LOCATE(',',${field})+1)) END AS bytes
        ${from}
      ) AS attachment_values
    `).split("\t").map(Number);
    if (![references, inlineVerified].every(n => Number.isSafeInteger(n) && n >= 0) || inlineVerified > references) {
      throw Error("ATTACHMENT_COUNTS_INVALID");
    }
    summary.references += references;
    summary.inlineVerified += inlineVerified;
    if (!root || references === inlineVerified) continue;

    const keys = sql(`SELECT ${field},COUNT(*) ${from}
      AND ${field} REGEXP '^single/(studio|storefront-customizer)/[A-Za-z0-9._/-]+$'
      GROUP BY ${field} ORDER BY ${field} LIMIT ${maxMirrorObjects}`);
    for (const row of keys.split("\n").filter(Boolean)) {
      const [key, count] = row.split("\t");
      if (await checkObject(key)) summary.mirroredVerified += Number(count);
    }
  }
  return summary;
}
