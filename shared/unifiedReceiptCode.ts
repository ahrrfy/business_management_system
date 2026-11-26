import {
  normalizeBarcodeScannerInput,
  normalizeKnownSystemBarcode,
  unwrapBarcodeScanEnvelope,
} from "./barcodeScanner";
import { docBarcode, stripDocPrefix } from "./documentNumber";

const HISTORICAL_DOC_NUMBER_RE =
  /^(?:INV|WO|PO|QUO|VCH|TRN|EXC|GIFT|ORD|CNS?|DRF|RET|PAY|REC)-\d+-\d{8}-\d+(?:-\d+)*$/i;
const HISTORICAL_DOC_BASE_RE =
  /^((?:INV|WO|PO|QUO|VCH|TRN|EXC|GIFT|ORD|CNS?|DRF|RET|PAY|REC)-\d+-\d{8}-\d+)(?:-\d+)+$/i;

function unwrapUnifiedCandidate(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const candidate = unwrapBarcodeScanEnvelope(trimmed);
  const normalizedCandidate = normalizeKnownSystemBarcode(candidate);
  const pipeMatch = /^(INV|WO|ORD|CNS?|PO|QUO|RV|PV|FR|AE|CHG)\|([^|]+)/i.exec(
    normalizedCandidate,
  );
  if (pipeMatch) {
    const prefix =
      pipeMatch[1]!.toUpperCase() === "CNS" ? "CN" : pipeMatch[1]!.toUpperCase();
    const num = stripDocPrefix(pipeMatch[2]!.trim()).replace(/^CNS-/i, "CN-");
    return docBarcode(prefix, num);
  }
  const systemCode = normalizeKnownSystemBarcode(candidate);
  if (/^(?:CNS?|INV|WO|ORD)-/i.test(systemCode)) return systemCode;
  return normalizeBarcodeScannerInput(candidate) || systemCode;
}

/**
 * يستخرج الرقم الأساسي للوصل الموحّد (مثل "103757" من "103757" أو "WO-103757" أو "103757-1")
 * بشرط ألا يقل طوله عن 3 محارف وأن يخلو من محارف البدل في LIKE (% و _).
 */
export function extractUnifiedReceiptBaseCode(rawCode: string): string | null {
  const candidate = unwrapUnifiedCandidate(rawCode);
  if (!candidate) return null;

  let baseCode: string;
  const stripped = stripDocPrefix(candidate).replace(/^CNS-/i, "CN-");
  if (HISTORICAL_DOC_NUMBER_RE.test(stripped)) {
    const histMatch = HISTORICAL_DOC_BASE_RE.exec(stripped);
    baseCode = histMatch ? histMatch[1]! : stripped;
  } else {
    const withoutPrefix = stripped.replace(/^(?:WO|INV|ORD|DRF|RCP)-/i, "");
    const siblingMatch = /^(.{3,}?)-\d+$/.exec(withoutPrefix);
    baseCode = siblingMatch ? siblingMatch[1]! : withoutPrefix;
  }

  baseCode = baseCode.trim();
  if (baseCode.length < 3 || baseCode.includes("%") || baseCode.includes("_")) {
    return null;
  }
  return baseCode;
}

/** يتحقّق ممّا إذا كان رقم أمر الشغل يحمل لاحقة شقيق منشطر (مثل 100234-1). */
export function hasUnifiedReceiptSiblingSuffix(rawOrderNumber: string): boolean {
  const trimmed = String(rawOrderNumber ?? "").trim();
  if (!trimmed) return false;
  const stripped = stripDocPrefix(trimmed);
  if (HISTORICAL_DOC_NUMBER_RE.test(stripped)) {
    return HISTORICAL_DOC_BASE_RE.test(stripped);
  }
  const withoutPrefix = stripped.replace(/^(?:WO|INV|ORD|DRF|RCP)-/i, "");
  return /^.{3,}?-\d+$/.test(withoutPrefix);
}
