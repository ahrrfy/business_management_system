import { useEffect, useState } from "react";
import {
  getOfflineProfile,
  resolveOfflinePermSnapshot,
  saveOfflinePermSnapshot,
  saveOfflineProfile,
} from "@/lib/offline/pinLock";
import { getMeta } from "@/lib/offline/db";
import { isOfflineSaleEnabled, subscribeOutbox } from "@/lib/offline/outbox";
import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { canSeeMode } from "@/pages/pos/posModeGates";
import type { PermissionMap, RoleKey } from "@shared/permissions";
import type { OperationPolicy, OperationUser } from "@shared/operationPermissions";

export interface POSOfflineUser {
  id: number;
  companyId?: number | null;
  name?: string | null;
  role?: string | null;
  branchId?: number | null;
  isOwner?: boolean | null;
  permissionsOverride?: PermissionMap | null;
  operationPolicyEnabled?: boolean | null;
  resolvedOperationPolicy?: OperationPolicy | null;
}

export function usePOSOfflineBoot(user: POSOfflineUser | null | undefined) {
  const [offlineBoot, setOfflineBoot] = useState<{
    userId: number | null;
    branchId: number | null;
    shiftId: number | null;
    name: string | null;
  } | null>(null);

  useEffect(() => {
    if (user) {
      setOfflineBoot(null);
      return;
    }
    void (async () => {
      const profile = await getOfflineProfile();
      let cachedShiftId: number | null = null;
      try {
        const raw = await getMeta("lastOpenShift");
        if (raw) cachedShiftId = Number((JSON.parse(raw) as { id?: number }).id) || null;
      } catch {
        /* كاش تالف ⇒ بلا وردية بديلة */
      }
      if (profile?.userId) {
        await resolveOfflinePermSnapshot(profile.userId, profile.branchId).catch(() => null);
      }
      setOfflineBoot({
        userId: profile?.userId ?? null,
        branchId: profile?.branchId ?? null,
        shiftId: cachedShiftId,
        name: profile?.name ?? null,
      });
    })();
  }, [user]);

  // ش٥ + v4: حفظ ملف الجهاز + لقطة الصلاحيات الفعلية المشفّرة بـAAD والمقيدة بالهوية والمدة (٤٨ ساعة).
  useEffect(() => {
    if (user) {
      const effectiveRole = (user.isOwner ? "admin" : (user.role ?? "user")) as RoleKey;
      const effOverride = (user.isOwner ? null : (user.permissionsOverride ?? null)) as PermissionMap | null;
      const effOpPolicy =
        user.operationPolicyEnabled && !user.isOwner
          ? (user.resolvedOperationPolicy ?? null)
          : null;
      const stationOk = canSeeMode("RETAIL", effectiveRole, effOverride, effOpPolicy);
      const createOk = lifecycleActionAllowed(user as unknown as OperationUser, "sales.create", true);
      void saveOfflineProfile({
        id: user.id,
        companyId: user.companyId ?? null,
        name: user.name ?? "",
        role: user.role ?? "",
        branchId: user.branchId ?? null,
      });
      void saveOfflinePermSnapshot({
        userId: user.id,
        branchId: user.branchId ?? null,
        role: effectiveRole,
        isOwner: Boolean(user.isOwner),
        permissionsOverride: effOverride,
        operationPolicyEnabled: Boolean(user.operationPolicyEnabled),
        resolvedOperationPolicy: effOpPolicy,
        canCreateRetailSale: Boolean(stationOk && createOk),
      });
    }
  }, [user]);

  // ش٥: مفتاح تجربة البيع الأوفلايني (لكل جهاز، افتراضياً معطَّل — قرار مالك).
  const [offlineSaleOn, setOfflineSaleOn] = useState(false);
  useEffect(() => {
    void isOfflineSaleEnabled().then(setOfflineSaleOn);
    const off = subscribeOutbox(() => void isOfflineSaleEnabled().then(setOfflineSaleOn));
    return off;
  }, []);

  return { offlineBoot, offlineSaleOn };
}
