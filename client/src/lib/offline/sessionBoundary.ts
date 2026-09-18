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

/** يحافظ على مسودات النطاق نفسه فقط؛ الشركة والمستخدم معاً هما حد الهوية. */
export async function resetSessionForLogin(
  queryClient: QueryClient,
  nextScope: StudioTenantScope,
  dependencies: SessionBoundaryDependencies = studioDraftDependencies,
): Promise<void> {
  await resetSessionQueryCache(queryClient);
  await Promise.resolve().then(() => dependencies.purgeReceptionSnapshots()).catch(() => undefined);
  const previousIdentity = await dependencies.loadStudioIdentity().catch(() => null);
  if (!sameStudioTenantScope(previousIdentity, nextScope)) await dependencies.purgeStudioDrafts().catch(() => undefined);
}

/** تسجيل الخروج الصريح حد أمنيّ يمحو كل المسودات والهوية المحلية ويوقف الصوت. */
export async function resetSessionForLogout(
  queryClient: QueryClient,
  dependencies: SessionBoundaryDependencies = studioDraftDependencies,
): Promise<void> {
  pauseGlobalQuranAudio();
  void clearNotificationBadge();
  await resetSessionQueryCache(queryClient);
  await Promise.resolve().then(() => dependencies.purgeReceptionSnapshots()).catch(() => undefined);
  await dependencies.purgeStudioDrafts().catch(() => undefined);
}
