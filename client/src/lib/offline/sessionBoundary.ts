import type { QueryClient } from "@tanstack/react-query";
import {
  loadStudioDraftIdentity,
  purgeAllStudioDrafts,
  type StudioDraftIdentity,
} from "@/lib/productStudio/studioDrafts";
import { sameStudioTenantScope, type StudioTenantScope } from "@/lib/productStudio/studioTenantScope";
import { pauseGlobalQuranAudio } from "@/components/quran/QuranAudioContext";
import { clearNotificationBadge } from "@/lib/push";
import { markReceptionWorkspaceBoundaryBlocked, purgeReceptionWorkspaceSnapshots } from "@/lib/receptionWorkspaceState";
import { offlineDb } from "./db";
import { lockOfflineSession } from "./pinLock";

type SessionBoundaryDependencies = {
  loadStudioIdentity: () => Promise<StudioDraftIdentity | null>;
  purgeStudioDrafts: () => Promise<void>;
  purgeReceptionSnapshots: () => void | Promise<void>;
};

const studioDraftDependencies: SessionBoundaryDependencies = {
  loadStudioIdentity: loadStudioDraftIdentity,
  purgeStudioDrafts: purgeAllStudioDrafts,
  purgeReceptionSnapshots: () => {
    if (typeof window === "undefined") return;
    try { purgeReceptionWorkspaceSnapshots(window.sessionStorage); } catch { markReceptionWorkspaceBoundaryBlocked(); }
  },
};

/**
 * A browser tab can authenticate several employees over its lifetime. Query keys
 * intentionally omit the user id because the server derives it from the cookie,
 * so cached operational data must not survive an identity boundary.
 */
export async function resetSessionQueryCache(
  queryClient: QueryClient,
): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.removeQueries();
}

export function purgeRecipeClipboard(): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith("alroya_recipe_clipboard") || key === "alroya_recipe_clipboard_v1")) {
        localStorage.removeItem(key);
      }
    }
  } catch {}
}

/** يحافظ على مسودات النطاق نفسه فقط؛ الشركة والمستخدم معاً هما حد الهوية. */
export async function resetSessionForLogin(
  queryClient: QueryClient,
  nextScope: StudioTenantScope,
  dependencies: SessionBoundaryDependencies = studioDraftDependencies,
): Promise<void> {
  await resetSessionQueryCache(queryClient);
  await Promise.resolve().then(() => dependencies.purgeReceptionSnapshots()).catch(() => undefined);
  const previousIdentity = await dependencies.loadStudioIdentity().catch(() => null);
  if (!sameStudioTenantScope(previousIdentity, nextScope)) {
    await dependencies.purgeStudioDrafts().catch(() => undefined);
    purgeRecipeClipboard();
  }
}

function isMissingIndexedDbError(err: unknown): boolean {
  const candidate = err as {
    name?: string;
    message?: string;
    inner?: { name?: string; message?: string } | null;
  } | null;
  return (
    candidate?.name === "MissingAPIError" ||
    candidate?.inner?.name === "MissingAPIError" ||
    Boolean(candidate?.message?.includes("MissingAPIError"))
  );
}

/** تسجيل الخروج الصريح حد أمنيّ يمحو كل المسودات والهوية المحلية ويوقف الصوت. */
export async function resetSessionForLogout(
  queryClient: QueryClient,
  dependencies: SessionBoundaryDependencies = studioDraftDependencies,
): Promise<void> {
  pauseGlobalQuranAudio();
  void clearNotificationBadge();
  lockOfflineSession();
  purgeRecipeClipboard();
  await resetSessionQueryCache(queryClient);
  await Promise.resolve().then(() => dependencies.purgeReceptionSnapshots()).catch(() => undefined);
  try {
    await dependencies.purgeStudioDrafts();
  } catch (err) {
    if (!isMissingIndexedDbError(err)) {
      await dependencies.purgeStudioDrafts();
    }
  }
  const preservedDeviceMeta = await Promise.all([
    offlineDb.meta.get("offlineSaleEnabled").catch(() => undefined),
    offlineDb.meta.get("storagePersisted").catch(() => undefined),
  ]);
  const clearTasks: Array<() => Promise<unknown>> = [
    () => offlineDb.profile.clear(),
    () => offlineDb.catalog.clear(),
    () => offlineDb.meta.clear(),
    () => offlineDb.customers.clear(),
    () => offlineDb.stock.clear(),
  ];
  const firstPass = await Promise.allSettled(clearTasks.map((fn) => fn()));
  const failedTasks = clearTasks.filter((_, idx) => {
    const res = firstPass[idx];
    return res.status === "rejected" && !isMissingIndexedDbError(res.reason);
  });
  if (failedTasks.length > 0) {
    const retryPass = await Promise.allSettled(failedTasks.map((fn) => fn()));
    const firstRetryFailure = retryPass.find(
      (res): res is PromiseRejectedResult =>
        res.status === "rejected" && !isMissingIndexedDbError(res.reason),
    );
    if (firstRetryFailure) {
      throw firstRetryFailure.reason;
    }
  }
  for (const row of preservedDeviceMeta) {
    if (row && typeof row.key === "string" && typeof row.value === "string") {
      await offlineDb.meta.put(row).catch(() => undefined);
    }
  }
}
