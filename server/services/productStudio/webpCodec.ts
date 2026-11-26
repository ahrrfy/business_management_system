import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { contentHash } from "../../lib/imageStore";
import {
  assertValidImageDataUrl,
  parseImageDimensions,
} from "../../lib/imageValidation";
import {
  MAX_STUDIO_THUMBNAIL_BYTES,
  MAX_STUDIO_THUMBNAIL_DIMENSION,
} from "./types";

export function fittedThumbnailDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    MAX_STUDIO_THUMBNAIL_DIMENSION / Math.max(width, height),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function isCompleteStillWebp(bytes: Buffer): boolean {
  return locateStillWebpFrame(bytes) !== null;
}

export function locateStillWebpFrame(
  bytes: Buffer,
): { width: number; height: number } | null {
  if (bytes.length < 20) return null;
  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  )
    return null;
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let offset = 12;
  let frame: { fourcc: string; at: number; size: number } | null = null;
  let frames = 0;
  let animated = false;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 0 || offset + 8 + size > bytes.length) return null;
    if (id === "VP8 " || id === "VP8L") {
      frames++;
      frame = { fourcc: id, at: offset + 8, size };
    }
    if (id === "ANIM" || id === "ANMF") animated = true;
    offset += 8 + size + (size % 2);
  }
  if (offset !== bytes.length || frames !== 1 || animated || !frame)
    return null;

  if (frame.fourcc === "VP8 ") {
    if (frame.size < 10) return null;
    const p = frame.at;
    if (
      bytes[p + 3] !== 0x9d ||
      bytes[p + 4] !== 0x01 ||
      bytes[p + 5] !== 0x2a
    )
      return null;
    return {
      width: bytes.readUInt16LE(p + 6) & 0x3fff,
      height: bytes.readUInt16LE(p + 8) & 0x3fff,
    };
  }
  if (frame.size < 5) return null;
  const p = frame.at;
  if (bytes[p] !== 0x2f) return null;
  const b1 = bytes[p + 1];
  const b2 = bytes[p + 2];
  const b3 = bytes[p + 3];
  const b4 = bytes[p + 4];
  return {
    width: 1 + (b1 | ((b2 & 0x3f) << 8)),
    height: 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
  };
}

export function decodeStudioThumbnail(
  dataUrl: string,
  processed: { width: number | null; height: number | null },
): {
  dataUrl: string;
  bytes: Buffer;
  width: number;
  height: number;
  hash: string;
} {
  const isWebp = dataUrl.startsWith("data:image/webp;base64,");
  const isJpeg = dataUrl.startsWith("data:image/jpeg;base64,");
  if (!isWebp && !isJpeg) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال المرشّح للمراجعة",
        why: "مصغّرة العرض التي أنتجها متصفّحك ليست WebP ولا JPEG، وهما الصيغتان المقبولتان",
        doThis:
          "حدّث الصفحة وأعد الإرسال، وإن تكرّر فجرّب متصفّحاً آخر أو أبلغ الدعم الفنّي",
      }),
    });
  }
  assertValidImageDataUrl(
    dataUrl,
    MAX_STUDIO_THUMBNAIL_BYTES,
    true,
    MAX_STUDIO_THUMBNAIL_DIMENSION,
  );
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const frame = isWebp ? locateStillWebpFrame(bytes) : null;
  const dimensions = isWebp ? frame : parseImageDimensions(bytes, "image/jpeg");
  let structureOk: boolean;
  if (isWebp) {
    structureOk = frame !== null;
  } else {
    structureOk =
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9;
  }
  if (
    !structureOk ||
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_STUDIO_THUMBNAIL_DIMENSION ||
    dimensions.height > MAX_STUDIO_THUMBNAIL_DIMENSION
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: isWebp
        ? appErrorMessage({
            what: "تعذّر إرسال المرشّح للمراجعة",
            why: "مصغّرة WebP التي أنتجها متصفّحك مبتورةٌ أو بلا إطار صورةٍ ثابت، أو تجاوز ضلعُها 320 بكسل",
            doThis:
              "حدّث الصفحة وأعد الإرسال ليُنتج المتصفّح مصغّرةً جديدة، وإن تكرّر فأبلغ الدعم الفنّي",
          })
        : appErrorMessage({
            what: "تعذّر إرسال المرشّح للمراجعة",
            why: "مصغّرة JPEG التي أنتجها متصفّحك مبتورةٌ (بلا خاتمة ملفّ) أو تجاوز ضلعُها 320 بكسل",
            doThis:
              "حدّث الصفحة وأعد الإرسال ليُنتج المتصفّح مصغّرةً جديدة، وإن تكرّر فأبلغ الدعم الفنّي",
          }),
    });
  }
  if (!processed.width || !processed.height) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال المرشّح للمراجعة",
        why: "أبعاد الصورة النهائية غير مقروءة، فلا سبيل للتحقّق أنّ المصغّرة مشتقّةٌ منها",
        doThis: "أعِد إنتاج الصورة النهائية من محرّر الاستوديو ثمّ أعد الإرسال",
      }),
    });
  }
  const expected = fittedThumbnailDimensions(processed.width, processed.height);
  if (
    dimensions.width !== expected.width ||
    dimensions.height !== expected.height
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال المرشّح للمراجعة",
        why: "أبعاد المصغّرة لا تطابق المشتقّ من الصورة النهائية (أطول ضلعٍ يُصغَّر إلى 320 بكسل)",
        doThis:
          "حدّث الصفحة وأعد إنتاج الصورة ومصغّرتها معاً ثمّ أعد الإرسال",
      }),
    });
  }
  return { dataUrl, bytes, ...dimensions, hash: contentHash(bytes) };
}
