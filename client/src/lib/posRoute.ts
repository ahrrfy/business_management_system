import { POS_STATION_GATES, type PosStation } from "@shared/permissions";

export type PosRouteMode = PosStation;

export const DEFAULT_POS_ROUTE_MODE: PosRouteMode = "RETAIL";

export interface PosRouteParts {
  /** تقبل صيغة useSearch (بلا ?) أو window.location.search (مع ?). */
  search?: string;
  /** تقبل صيغة window.location.hash (مع #) أو القيمة الخام. */
  hash?: string;
}

export interface PosRouteAccess {
  invalidMode: boolean;
  reservationsWorkspace: boolean;
  canReadReservations: boolean;
  canSeeReception: boolean;
  canSeeActiveMode: boolean;
}

const POS_ROUTE_MODE_SET: ReadonlySet<string> = new Set(
  Object.keys(POS_STATION_GATES),
);

/**
 * يقرأ محطة POS المطلوبة. غياب `mode` يعني RETAIL، أمّا القيمة المجهولة أو المكررة
 * فتعيد null كي يستطيع الغلاف إعادة التوجيه إلى أول محطة مسموحة بدلاً من فتح محطة خاطئة.
 */
export function readPosMode(search: string): PosRouteMode | null {
  const params = new URLSearchParams(stripQuestionMark(search));
  const requestedModes = params.getAll("mode");

  if (requestedModes.length === 0) return DEFAULT_POS_ROUTE_MODE;
  if (requestedModes.length !== 1) return null;

  const [requestedMode] = requestedModes;
  return POS_ROUTE_MODE_SET.has(requestedMode)
    ? (requestedMode as PosRouteMode)
    : null;
}

/** مساحة الحجوزات المضمّنة هي جسرٌ مستقل لمن لا يملك محطة الاستقبال نفسها. */
export function isEmbeddedReservationsWorkspace(
  reservationsWorkspace: boolean,
  canSeeReception: boolean,
): boolean {
  return reservationsWorkspace && !canSeeReception;
}

/** يمنع mode التالف دائماً، ويقصر استثناء بوابة المحطة على جسر الحجوزات المضمّن. */
export function isPosRouteAccessDenied(access: PosRouteAccess): boolean {
  if (access.invalidMode) return true;

  return isEmbeddedReservationsWorkspace(
    access.reservationsWorkspace,
    access.canSeeReception,
  )
    ? !access.canReadReservations
    : !access.canSeeActiveMode;
}

/**
 * يبني رابط انتقال محطة POS مع إبقاء معاملات السياق كما كُتبت (ترتيباً وترميزاً) والـhash.
 * `workspace=reservations` محدد شاشة متنافر مع المحطات، لذلك يُزال عند انتقال محطة صريح.
 */
export function buildPosModeUrl(
  parts: PosRouteParts,
  nextMode: PosRouteMode,
): string {
  const rawSearch = stripQuestionMark(parts.search ?? "");
  const segments = rawSearch.length > 0 ? rawSearch.split("&") : [];
  const nextSegments: string[] = [];
  let wroteMode = false;

  for (const segment of segments) {
    const parameter = readRawParameter(segment);

    if (parameter?.key === "workspace" && parameter.value === "reservations") {
      continue;
    }

    if (parameter?.key === "mode") {
      if (nextMode !== DEFAULT_POS_ROUTE_MODE && !wroteMode) {
        nextSegments.push(`mode=${encodeURIComponent(nextMode)}`);
        wroteMode = true;
      }
      continue;
    }

    if (segment.length > 0) nextSegments.push(segment);
  }

  if (nextMode !== DEFAULT_POS_ROUTE_MODE && !wroteMode) {
    nextSegments.push(`mode=${encodeURIComponent(nextMode)}`);
  }

  const query = nextSegments.length > 0 ? `?${nextSegments.join("&")}` : "";
  const hash = normalizeHash(parts.hash ?? "");
  return `/pos${query}${hash}`;
}

function stripQuestionMark(search: string): string {
  return search.startsWith("?") ? search.slice(1) : search;
}

function normalizeHash(hash: string): string {
  if (hash.length === 0) return "";
  return hash.startsWith("#") ? hash : `#${hash}`;
}

function readRawParameter(
  segment: string,
): { key: string; value: string | null } | null {
  const separator = segment.indexOf("=");
  const rawKey = separator >= 0 ? segment.slice(0, separator) : segment;
  const rawValue = separator >= 0 ? segment.slice(separator + 1) : "";

  let key: string;
  try {
    key = decodeFormComponent(rawKey);
  } catch {
    // مفتاح بترميز percent تالف ليس mode/workspace صالحاً؛ نُبقي المعامل كما هو.
    return null;
  }

  try {
    return { key, value: decodeFormComponent(rawValue) };
  } catch {
    // نحتفظ بالمفتاح المقروء حتى نستبدل mode التالف ولا نصنع مفتاحين متكررين.
    return { key, value: null };
  }
}

function decodeFormComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, " "));
}
