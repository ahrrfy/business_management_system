import type { AppSectionId, ApplicationModule } from "./moduleRegistry";

export const SIDEBAR_SECTION_LABELS: Readonly<Record<AppSectionId, string>> =
  Object.freeze({
    1: "المبيعات والعملاء",
    2: "المخزون والتوريد",
    3: "المالية والتقارير",
    4: "التشغيل والقنوات",
    5: "الإدارة",
  });

export type SidebarModuleGroup = Readonly<{
  id: AppSectionId;
  label: string;
  modules: readonly ApplicationModule[];
}>;

function parseHref(href: string): {
  path: string;
  search: URLSearchParams;
} {
  const withoutHash = href.split("#", 1)[0] ?? href;
  const queryAt = withoutHash.indexOf("?");
  const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutHash.slice(queryAt + 1);
  return { path: path || "/", search: new URLSearchParams(query) };
}

/**
 * يطابق مدخل التنقّل مع المسار الحالي، مع إبقاء تبويبات query مستقلة.
 * محطة التجزئة هي الوضع الافتراضي التاريخي لـ /pos، لذلك غياب mode يعادل RETAIL فقط.
 */
export function isSidebarHrefActive(
  currentPath: string,
  currentSearch: string,
  targetHref: string,
): boolean {
  const target = parseHref(targetHref);
  const pathMatches =
    currentPath === target.path ||
    (target.path !== "/" && currentPath.startsWith(`${target.path}/`));
  if (!pathMatches) return false;
  if (target.search.toString() === "") return true;

  const current = new URLSearchParams(
    currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch,
  );
  let matches = true;
  target.search.forEach((expected, key) => {
    if (
      target.path === "/pos" &&
      key === "mode" &&
      expected === "RETAIL" &&
      !current.has("mode")
    ) {
      return;
    }
    if (!current.getAll(key).includes(expected)) matches = false;
  });
  return matches;
}

export function groupSidebarModules(
  modules: readonly ApplicationModule[],
): readonly SidebarModuleGroup[] {
  return ([1, 2, 3, 4, 5] as const)
    .map((id) => ({
      id,
      label: SIDEBAR_SECTION_LABELS[id],
      modules: modules.filter((module) => module.section === id),
    }))
    .filter((group) => group.modules.length > 0);
}

/** يعيد أقرب وحدة جذرية لمدخل workspace مثل /purchases/new أو /crm?tab=inbox. */
export function findSidebarModule(
  href: string,
  modules: readonly ApplicationModule[],
): ApplicationModule | null {
  const { path } = parseHref(href);
  return (
    modules
      .filter(
        (module) =>
          path === module.href || path.startsWith(`${module.href}/`),
      )
      .sort((left, right) => right.href.length - left.href.length)[0] ?? null
  );
}
