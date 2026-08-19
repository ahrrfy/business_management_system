import type { QueryClient } from "@tanstack/react-query";
import { purgeAllStudioDrafts } from "@/lib/productStudio/studioDrafts";

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
  // لا تبقى مسودة نص/صورة قابلة للاستعادة بعد تبدّل الموظف أو تسجيل الخروج.
  await purgeAllStudioDrafts().catch(() => undefined);
}
