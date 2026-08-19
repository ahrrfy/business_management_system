import type { QueryClient } from "@tanstack/react-query";
import {
  loadStudioDraftIdentity,
  purgeAllStudioDrafts,
} from "@/lib/productStudio/studioDrafts";

type SessionBoundaryDependencies = {
  loadStudioIdentity: () => Promise<{ userId: number } | null>;
  purgeStudioDrafts: () => Promise<void>;
};

const studioDraftDependencies: SessionBoundaryDependencies = {
  loadStudioIdentity: loadStudioDraftIdentity,
  purgeStudioDrafts: purgeAllStudioDrafts,
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

/** يمسح مسودات الاستوديو فقط عند ثبوت انتقال الجهاز إلى موظف آخر. */
export async function resetSessionForLogin(
  queryClient: QueryClient,
  nextUserId: number,
  dependencies: SessionBoundaryDependencies = studioDraftDependencies,
): Promise<void> {
  const previousIdentity = await dependencies
    .loadStudioIdentity()
    .catch(() => null);
  await resetSessionQueryCache(queryClient);
  if (
    previousIdentity != null &&
    Number(previousIdentity.userId) !== Number(nextUserId)
  ) {
    await dependencies.purgeStudioDrafts().catch(() => undefined);
  }
}

/** تسجيل الخروج الصريح حد أمنيّ يمحو كل المسودات والهوية المحلية. */
export async function resetSessionForLogout(
  queryClient: QueryClient,
  dependencies: SessionBoundaryDependencies = studioDraftDependencies,
): Promise<void> {
  await resetSessionQueryCache(queryClient);
  await dependencies.purgeStudioDrafts().catch(() => undefined);
}
