/**
 * geoCoordinates — محلّل ومولّد موحّد لإحداثيات وروابط خرائط Google عبر المتجر ولوحة الإدارة وتطبيقات الجوال.
 *
 * يعالج:
 *  1) أولوية الدبوس الفعلي `!3d<lat>!4d<lng>` قبل مركز الكاميرا `@<lat>,<lng>` لمنع انحراف موقع العميل.
 *  2) الروابط المضمّنة داخل رسائل واتساب متعددة الأسطر ومعاملات `q` و`query` و`ll` و`daddr` و`destination` و`center` ومسارات `/maps/search/` و`geo:`.
 *  3) الأرقام العربية الشرقية (٠-٩) والفارسية (۰-۹) والفاصلة العربية (،) وعلامات اتجاه النص الخفية.
 *  4) التحقق الصارم من النطاق الجغرافي واستبعاد نقطة الصفر `(0, 0)` وتوحيد الدقة إلى 6 خانات عشرية.
 *  5) اكتشاف الروابط المختصرة الآمنة (`maps.app.goo.gl` / `goo.gl/maps`) لفكّها خادمياً بحماية SSRF.
 */

export interface GeoCoordinates {
  lat: number;
  lng: number;
}

export const ALLOWED_GOOGLE_MAPS_SHORT_HOSTS: readonly string[] = [
  "maps.app.goo.gl",
  "goo.gl",
  "www.google.com",
  "maps.google.com",
  "google.com",
];

/** تحويل الأرقام العربية/الفارسية والفواصل العربية وإزالة محارف التحكم باتجاه النص. */
export function normalizeCoordinateText(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 0x0660 && code <= 0x0669) {
      out += String(code - 0x0660);
    } else if (code >= 0x06f0 && code <= 0x06f9) {
      out += String(code - 0x06f0);
    } else if (code === 0x060c || code === 0x061b) {
      out += ",";
    } else if (code === 0x066b) {
      out += ".";
    } else if (
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      continue;
    } else {
      out += raw.charAt(i);
    }
  }
  return out.trim();
}

export function isValidGeoCoordinates(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return false;
  return true;
}

function toRoundedCoords(latRaw: string | number, lngRaw: string | number): GeoCoordinates | null {
  const lat = typeof latRaw === "number" ? latRaw : Number(latRaw);
  const lng = typeof lngRaw === "number" ? lngRaw : Number(lngRaw);
  if (!isValidGeoCoordinates(lat, lng)) return null;
  return {
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
  };
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCoordPairToken(value: string): GeoCoordinates | null {
  const cleaned = normalizeCoordinateText(safeDecodeUri(value))
    .replace(/^loc:/i, "")
    .trim();
  const match = cleaned.match(/^([+-]?\d{1,2}(?:\.\d+)?)\s*(?:,\s*|\s+)\s*([+-]?\d{1,3}(?:\.\d+)?)$/);
  if (!match) return null;
  return toRoundedCoords(match[1], match[2]);
}

function extractPin3d4d(text: string): GeoCoordinates | null {
  const decoded = normalizeCoordinateText(safeDecodeUri(text));
  const pinRegex = /!3d([+-]?\d{1,2}(?:\.\d+)?)!4d([+-]?\d{1,3}(?:\.\d+)?)/g;
  let match: RegExpExecArray | null = null;
  let lastValid: GeoCoordinates | null = null;
  while ((match = pinRegex.exec(decoded)) !== null) {
    const candidate = toRoundedCoords(match[1], match[2]);
    if (candidate) {
      lastValid = candidate;
    }
  }
  return lastValid;
}

function parseSingleUrl(rawUrl: string): GeoCoordinates | null {
  const cleanedUrl = rawUrl.replace(/[).,;!?]+$/, "");

  const pinCoords = extractPin3d4d(cleanedUrl);
  if (pinCoords) return pinCoords;

  try {
    const url = new URL(cleanedUrl);
    const paramKeys = ["q", "query", "ll", "daddr", "destination", "center", "sll", "viewpoint"];
    for (let i = 0; i < paramKeys.length; i++) {
      const val = url.searchParams.get(paramKeys[i]);
      if (!val) continue;
      const direct = parseCoordPairToken(val);
      if (direct) return direct;
      const embeddedMatch = normalizeCoordinateText(val).match(
        /([+-]?\d{1,2}\.\d+)\s*,\s*([+-]?\d{1,3}\.\d+)/,
      );
      if (embeddedMatch) {
        const parsed = toRoundedCoords(embeddedMatch[1], embeddedMatch[2]);
        if (parsed) return parsed;
      }
    }

    const decodedPath = normalizeCoordinateText(safeDecodeUri(url.pathname));
    const searchOrPlaceMatch = decodedPath.match(
      /\/maps\/(?:search|place|dir)\/(?:[^/]*\/)?([+-]?\d{1,2}\.\d+)\s*,\s*([+-]?\d{1,3}\.\d+)/,
    );
    if (searchOrPlaceMatch) {
      const parsed = toRoundedCoords(searchOrPlaceMatch[1], searchOrPlaceMatch[2]);
      if (parsed) return parsed;
    }

    const atMatch = decodedPath.match(/@([+-]?\d{1,2}(?:\.\d+)?),([+-]?\d{1,3}(?:\.\d+)?)/);
    if (atMatch) {
      const parsed = toRoundedCoords(atMatch[1], atMatch[2]);
      if (parsed) return parsed;
    }

    const hashDecoded = normalizeCoordinateText(safeDecodeUri(url.hash));
    const hashPin = extractPin3d4d(hashDecoded);
    if (hashPin) return hashPin;
    const hashAt = hashDecoded.match(/@([+-]?\d{1,2}(?:\.\d+)?),([+-]?\d{1,3}(?:\.\d+)?)/);
    if (hashAt) {
      const parsed = toRoundedCoords(hashAt[1], hashAt[2]);
      if (parsed) return parsed;
    }
  } catch {
    // متابعة التحليل النصي الاحتياطي عند تعذّر بناء URL قياسي
  }

  return null;
}

/**
 * استخراج إحداثيات التوصيل من نص حر، زوج إحداثيات، رسالة واتساب، أو رابط خرائط Google/Apple/geo.
 */
export function parseGeoCoordinates(input: string | null | undefined): GeoCoordinates | null {
  if (!input) return null;
  const normalized = normalizeCoordinateText(input);
  if (!normalized) return null;

  // 1) زوج إحداثيات مباشر بالكامل (يدعم الأرقام العشرية أو الصحيحة عند الإدخال الصريح)
  const exactPair = parseCoordPairToken(normalized);
  if (exactPair) return exactPair;

  // 2) روابط geo:lat,lng القياسية في أندرويد
  const geoUriMatch = normalized.match(/geo:([+-]?\d{1,2}(?:\.\d+)?),([+-]?\d{1,3}(?:\.\d+)?)/i);
  if (geoUriMatch) {
    const coords = toRoundedCoords(geoUriMatch[1], geoUriMatch[2]);
    if (coords) return coords;
  }

  // 3) الدبوس الدقيق !3d...!4d... إن وُجد في أي موضع من النص
  const directPin = extractPin3d4d(normalized);
  if (directPin) return directPin;

  // 4) استخراج أي روابط HTTP/HTTPS مضمّنة (مثل رسائل واتساب) وفحصها بالترتيب
  const urlMatches = normalized.match(/https?:\/\/[^\s<>"']+/gi);
  if (urlMatches) {
    for (let i = 0; i < urlMatches.length; i++) {
      const parsed = parseSingleUrl(urlMatches[i]);
      if (parsed) return parsed;
    }
  }

  // 5) زوج إحداثيات عشري مضمّن داخل سطر نصي (يشترط وجود فاصلة عشرية لتجنّب أرقام الهواتف والمحلات)
  const embeddedDecimalPair = normalized.match(
    /(?:^|[^\d+-])([+-]?\d{1,2}\.\d{3,})\s*(?:,\s*|\s+)\s*([+-]?\d{1,3}\.\d{3,})(?=$|[^\d.])/,
  );
  if (embeddedDecimalPair) {
    return toRoundedCoords(embeddedDecimalPair[1], embeddedDecimalPair[2]);
  }

  return null;
}

/** التحقق من أن الرابط آمن ومسموح لفكّ الاختصار خادمياً (منع SSRF). */
export function isAllowedGoogleMapsResolveUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== "443") return false;
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_GOOGLE_MAPS_SHORT_HOSTS.includes(host)) return false;
    if (host === "goo.gl" && !parsed.pathname.startsWith("/maps")) return false;
    return parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

/** استخراج رابط خرائط Google مختصر قابل للفك الخادمي من نص أو رسالة واتساب. */
export function extractShortMapUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const normalized = normalizeCoordinateText(input);
  const urlMatches = normalized.match(/https?:\/\/[^\s<>"']+/gi);
  if (!urlMatches) return null;
  for (let i = 0; i < urlMatches.length; i++) {
    const candidate = urlMatches[i].replace(/[).,;!?]+$/, "");
    if (isAllowedGoogleMapsResolveUrl(candidate) && !parseSingleUrl(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** بناء رابط خرائط Google الرسمي المتوافق مع كافة المنصات (Universal Cross-Platform URL). */
export function buildGoogleMapsUrl(
  lat: number | string | null | undefined,
  lng: number | string | null | undefined,
): string | null {
  if (lat == null || lng == null || lat === "" || lng === "") return null;
  const coords = toRoundedCoords(lat, lng);
  if (!coords) return null;
  return `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`;
}
