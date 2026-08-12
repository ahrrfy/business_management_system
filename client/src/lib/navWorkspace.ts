/**
 * اختصارات التنقّل المحلية: لا نُخزّن إلا جذور صفحات ثابتة مرئية للمستخدم.
 * لا أسماء، لا معرّفات مستندات، ولا query strings من صفحات التفاصيل.
 */

export const NAV_WORKSPACE_STORAGE_PREFIX = "erp.navWorkspace.v1";
export const NAV_FAVORITES_LIMIT = 6;
export const NAV_RECENT_LIMIT = 6;

const LAST_COMPANY_CODE_KEY = "erp.lastCompanyCode";
const SAFE_NAV_PATH = /^\/(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?$/;

// بعض شاشات التفاصيل لها مسارات تاريخية مستقلة عن جذر الـhub الظاهر في القائمة.
// نربط العائلة فقط بالجذر، ولا نعيد أو نخزّن أي معرّف منتج أو query string.
const NAV_ROOT_ALIASES: ReadonlyArray<{ prefix: string; root: string }> = [
  { prefix: "/products", root: "/inventory" },
];

export type NavWorkspace = {
  favorites: string[];
  recent: string[];
};

export type NavStorage = Pick<Storage, "getItem" | "setItem">;

export const EMPTY_NAV_WORKSPACE: NavWorkspace = Object.freeze({
  favorites: [],
  recent: [],
});

function safeAllowedPaths(allowedPaths: readonly string[]): Set<string> {
  return new Set(
    allowedPaths.filter((path) => path.length <= 96 && SAFE_NAV_PATH.test(path)),
  );
}

function sanitizeList(
  value: unknown,
  allowed: ReadonlySet<string>,
  limit: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !allowed.has(candidate) || result.includes(candidate)) continue;
    result.push(candidate);
    if (result.length === limit) break;
  }
  return result;
}

/** مفتاح معزول لكل شركة/مستخدم؛ القيمة نفسها لا تحتوي إلا مسارات. */
export function navWorkspaceStorageKey(userId: number, companyCode?: string | null): string {
  const safeUserId = Number.isSafeInteger(userId) && userId > 0 ? String(userId) : "unknown";
  const company = (companyCode?.trim().toLowerCase() || "single").slice(0, 40);
  return `${NAV_WORKSPACE_STORAGE_PREFIX}:${encodeURIComponent(company)}:${safeUserId}`;
}

/** رمز الشركة محفوظ أصلاً لتسهيل تسجيل الدخول؛ غيابه يعني نشر شركة واحدة. */
export function readLastCompanyCode(storage: Pick<Storage, "getItem">): string | null {
  try {
    const value = storage.getItem(LAST_COMPANY_CODE_KEY)?.trim();
    return value ? value.slice(0, 40) : null;
  } catch {
    return null;
  }
}

/** يزيل فوراً أي رابط لم يعد ضمن القائمة المسموحة للدور الحالي. */
export function filterNavWorkspace(
  workspace: Partial<NavWorkspace> | null | undefined,
  allowedPaths: readonly string[],
): NavWorkspace {
  const allowed = safeAllowedPaths(allowedPaths);
  return {
    favorites: sanitizeList(workspace?.favorites, allowed, NAV_FAVORITES_LIMIT),
    recent: sanitizeList(workspace?.recent, allowed, NAV_RECENT_LIMIT),
  };
}

export function loadNavWorkspace(
  storage: Pick<Storage, "getItem">,
  key: string,
  allowedPaths: readonly string[],
): NavWorkspace {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { favorites: [], recent: [] };
    return filterNavWorkspace(JSON.parse(raw) as Partial<NavWorkspace>, allowedPaths);
  } catch {
    return { favorites: [], recent: [] };
  }
}

export function saveNavWorkspace(
  storage: Pick<Storage, "setItem">,
  key: string,
  workspace: NavWorkspace,
  allowedPaths: readonly string[],
): NavWorkspace {
  const filtered = filterNavWorkspace(workspace, allowedPaths);
  try {
    storage.setItem(key, JSON.stringify(filtered));
  } catch {
    // امتلاء/حجب localStorage لا يعطّل التنقّل؛ تبقى الحالة في الذاكرة لهذه الجلسة.
  }
  return filtered;
}

export function toggleFavorite(workspace: NavWorkspace, path: string): NavWorkspace {
  if (workspace.favorites.includes(path)) {
    return { ...workspace, favorites: workspace.favorites.filter((item) => item !== path) };
  }
  if (workspace.favorites.length >= NAV_FAVORITES_LIMIT) return workspace;
  return { ...workspace, favorites: [path, ...workspace.favorites] };
}

export function recordRecent(workspace: NavWorkspace, path: string): NavWorkspace {
  return {
    ...workspace,
    recent: [path, ...workspace.recent.filter((item) => item !== path)].slice(0, NAV_RECENT_LIMIT),
  };
}

/**
 * يحوّل أي شاشة تفصيل إلى جذر وحدتها (مثلاً /invoices/123 -> /invoices)،
 * وبذلك لا يدخل أي معرّف أعمال إلى localStorage.
 */
export function resolveNavRoot(location: string, allowedPaths: readonly string[]): string | null {
  const pathname = location.split(/[?#]/, 1)[0] || "/";
  const allowed = safeAllowedPaths(allowedPaths);
  const candidates = Array.from(allowed).sort((a, b) => b.length - a.length);
  const direct = candidates.find((path) => pathname === path || pathname.startsWith(`${path}/`));
  if (direct) return direct;
  const alias = NAV_ROOT_ALIASES.find(({ prefix, root }) =>
    allowed.has(root) && (pathname === prefix || pathname.startsWith(`${prefix}/`)),
  );
  return alias?.root ?? null;
}
