import { useCallback, useEffect, useState } from "react";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { getLastSyncAt, offlineFindByBarcode, offlineSearchCatalog } from "@/lib/offline/catalogSync";
import { OFFLINE_CACHE_MAX_AGE_MS } from "@/lib/offline/outbox";
import { notify } from "@/lib/notify";
import { parseScan } from "@/lib/scanRouter";
import { trpc } from "@/lib/trpc";
import { keepPreviousData } from "@tanstack/react-query";
import { useSmartScanInput } from "@/components/pos/useSmartScanInput";
import type { PosRow, Tier } from "./posShared";

export interface UsePOSCatalogSearchParams {
  search: string;
  setSearch: (val: string) => void;
  branchId: number;
  effectiveTier: Tier;
  customerId: number | null | undefined;
  offline: boolean;
  addRow: (row: PosRow) => void;
  setCustId: (id: number | null) => void;
  scannerEnabled: boolean;
}

export function usePOSCatalogSearch({
  search,
  setSearch,
  branchId,
  effectiveTier,
  customerId,
  offline,
  addRow,
  setCustId,
  scannerEnabled,
}: UsePOSCatalogSearchParams) {
  const utils = trpc.useUtils();
  const debouncedSearch = useDebouncedValue(search, 180);

  const searchResults = trpc.catalog.posList.useQuery(
    { branchId, tier: effectiveTier, query: debouncedSearch, limit: 20, customerId },
    {
      enabled: !offline && debouncedSearch.trim().length >= 2,
      placeholderData: keepPreviousData,
      staleTime: 0,
    },
  );

  const [offlineResults, setOfflineResults] = useState<PosRow[]>([]);
  const [offlineSearching, setOfflineSearching] = useState(false);

  useEffect(() => {
    if (!offline || debouncedSearch.trim().length < 2) {
      setOfflineResults([]);
      setOfflineSearching(false);
      return;
    }
    let cancelled = false;
    setOfflineSearching(true);
    void offlineSearchCatalog(debouncedSearch, effectiveTier, branchId, { limit: 20 })
      .then((rows) => {
        if (!cancelled) {
          setOfflineResults(rows as PosRow[]);
          setOfflineSearching(false);
        }
      })
      .catch(() => {
        if (!cancelled) setOfflineSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, branchId, effectiveTier, offline]);

  const lookupBarcode = useCallback(
    async (code: string) => {
      if (!code) return;
      try {
        let row: unknown;
        if (offline) {
          row = await offlineFindByBarcode(code, effectiveTier, branchId);
        } else {
          try {
            row = await utils.catalog.byBarcode.fetch({
              barcode: code,
              branchId,
              tier: effectiveTier,
              customerId,
            });
          } catch (fetchErr) {
            if (!customerId) {
              const lastSync = await getLastSyncAt();
              const isFresh = Boolean(
                lastSync && Date.now() - new Date(lastSync).getTime() <= OFFLINE_CACHE_MAX_AGE_MS,
              );
              if (isFresh) {
                row = await offlineFindByBarcode(code, effectiveTier, branchId);
              }
            }
            if (!row) throw fetchErr;
          }
        }
        if (!row) notify.err(`باركود غير معروف: ${code}`);
        else addRow(row as PosRow);
      } catch (e: unknown) {
        notify.err(e, "خطأ في المسح");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branchId, effectiveTier, customerId, offline],
  );

  const { handleKeyDown: handleScanKeyDown } = useSmartScanInput(lookupBarcode);

  const handleHidScan = useCallback(
    async (raw: string) => {
      const result = parseScan(raw);
      if (result.type === "product") {
        await lookupBarcode(result.barcode);
        setSearch("");
      } else if (result.type === "customer") {
        setCustId(result.id);
        notify.ok(`تم تحديد العميل #${result.id}`);
      } else if (result.type === "employee" || result.type === "user") {
        notify.err("كود موظف/مستخدم — افتح البحث الشامل (Ctrl+K) لعرضه؛ لا ينطبق على نقطة البيع.");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lookupBarcode],
  );

  useBarcodeScanner(handleHidScan, { enabled: scannerEnabled });

  return {
    debouncedSearch,
    searchResults,
    offlineResults,
    offlineSearching,
    lookupBarcode,
    handleScanKeyDown,
  };
}
