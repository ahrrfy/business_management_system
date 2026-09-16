import { useEffect, useState } from "react";
import { getOfflineProfile, saveOfflineProfile } from "@/lib/offline/pinLock";
import { getMeta } from "@/lib/offline/db";
import { isOfflineSaleEnabled, subscribeOutbox } from "@/lib/offline/outbox";

export interface POSOfflineUser {
  id: number;
  name?: string | null;
  role?: string | null;
  branchId?: number | null;
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
      setOfflineBoot({
        userId: profile?.userId ?? null,
        branchId: profile?.branchId ?? null,
        shiftId: cachedShiftId,
        name: profile?.name ?? null,
      });
    })();
  }, [user]);

  // ش٥: حفظ ملف الجهاز عند كل جلسة أونلاين — وقود بوابة PIN والإقلاع الأوفلايني.
  useEffect(() => {
    if (user) {
      void saveOfflineProfile({
        id: user.id,
        name: user.name ?? "",
        role: user.role ?? "",
        branchId: user.branchId ?? null,
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
