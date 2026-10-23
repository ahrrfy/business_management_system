/**
 * مزامنة أرصدة المخزون الحيّة لمحرّرات الفواتير وعروض الأسعار المشتركة (`invoiceReducer`).
 *
 * تعالج ثلاث علل بنيوية في موضعٍ واحد:
 * 1) تثبيت مفتاح الوحدات نصّياً (`allStockUnitIdsKey`) بحيث لا تؤدي تحديثات السطور (كمية/سعر/خصم
 *    أو `SET_STOCK_SNAPSHOTS` نفسه) إلى كسر مرجع المصفوفة وإشعال حلقة `useEffect` لانهائية.
 * 2) تطبيق الدفعة الأولى (أول 500 وحدة) تزامنياً وفوراً، ثم دمج كل دفعة لاحقة (> 500 وحدة)
 *    بصورة مستقلّة فور اكتمالها عبر `Promise.allSettled` وبلا تخزين مؤقّت قديم (`staleTime: 0`)
 *    مع إعادة المحاولة عند كل نبضة `dataUpdatedAt` دون حجب الدفعات الجاهزة أو تصفير المتعثّرة.
 * 3) عزل `trpc.useUtils()` داخل `useRef` وحراسة `branchId > 0` و`productUnitId > 0` لمطابقة عقد الخادم.
 */
import { type Dispatch, useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import type { InvoiceAction, InvoiceLine } from "./types";

const STOCK_QUERY_CHUNK_SIZE = 500;

interface StockSnapshotRow {
  productUnitId: number;
  branchId: number;
  stockBase: number;
  reservedBase: number;
  availableBase: number;
  isService: boolean;
  allowBackorder: boolean;
}

function toSnapshotsByUnitId(rows: readonly StockSnapshotRow[]) {
  return Object.fromEntries(
    rows.map((row) => [
      row.productUnitId,
      {
        stockBase: row.stockBase,
        stockBranchId: row.branchId,
        reservedBase: row.reservedBase,
        availableBase: row.availableBase,
        isService: row.isService,
        allowBackorder: row.allowBackorder,
      },
    ]),
  );
}

export function useInvoiceLiveStockSync(args: {
  items: readonly InvoiceLine[];
  branchId: number;
  enabled?: boolean;
  dispatch: Dispatch<InvoiceAction>;
}): void {
  const { items, branchId, enabled = true, dispatch } = args;
  const utils = trpc.useUtils();
  const utilsRef = useRef(utils);
  utilsRef.current = utils;

  // مفتاح نصّيّ بدائيّ مستقرّ: لا يتغيّر إلا عند إضافة/حذف/تبديل معرّف وحدة موجب وصحيح فعلياً.
  const allStockUnitIdsKey = useMemo(() => {
    const seen = new Set<number>();
    for (const item of items) {
      if (Number.isInteger(item.productUnitId) && item.productUnitId > 0) {
        seen.add(item.productUnitId);
      }
    }
    return Array.from(seen).join(",");
  }, [items]);

  const allStockUnitIds = useMemo(
    () => (allStockUnitIdsKey === "" ? [] : allStockUnitIdsKey.split(",").map(Number)),
    [allStockUnitIdsKey],
  );

  const stockUnitIds = useMemo(
    () => allStockUnitIds.slice(0, STOCK_QUERY_CHUNK_SIZE),
    [allStockUnitIds],
  );

  const hasValidBranch = Number.isInteger(branchId) && branchId > 0;
  const queryEnabled = enabled && hasValidBranch && stockUnitIds.length > 0;

  const liveStockQ = trpc.catalog.stockByUnitIds.useQuery(
    { branchId, productUnitIds: stockUnitIds },
    {
      enabled: queryEnabled,
      staleTime: 0,
      refetchInterval: queryEnabled ? 15_000 : false,
      refetchOnWindowFocus: true,
    },
  );

  useEffect(() => {
    dispatch({ type: "MARK_STOCK_STALE" });
  }, [branchId, dispatch]);

  useEffect(() => {
    if (!queryEnabled) return;
    const snapshot = liveStockQ.data;
    if (!snapshot) return;
    // غير الأدمن قد يطلب فرعاً آخر من واجهة/مسودة قديمة، لكن الخادم يجبره على فرع حسابه.
    if (snapshot.branchId !== branchId) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: snapshot.branchId });
      return;
    }

    const baseRows = snapshot.rows;
    const effectiveBranchId = snapshot.branchId;
    const firstChunkIds = allStockUnitIds.slice(0, STOCK_QUERY_CHUNK_SIZE);

    // طبّق الدفعة الأولى المتاحة فوراً كي لا تبقى معلّقة بانتظار دفعات لاحقة بطيئة أو متعثّرة.
    dispatch({
      type: "SET_STOCK_SNAPSHOTS",
      queriedUnitIds: firstChunkIds,
      effectiveBranchId,
      snapshotsByUnitId: toSnapshotsByUnitId(baseRows),
    });

    if (allStockUnitIds.length <= STOCK_QUERY_CHUNK_SIZE) {
      return;
    }

    let cancelled = false;
    const extraChunks: number[][] = [];
    for (let i = STOCK_QUERY_CHUNK_SIZE; i < allStockUnitIds.length; i += STOCK_QUERY_CHUNK_SIZE) {
      extraChunks.push(allStockUnitIds.slice(i, i + STOCK_QUERY_CHUNK_SIZE));
    }

    void Promise.allSettled(
      extraChunks.map(async (chunk) => {
        const extra = await utilsRef.current.catalog.stockByUnitIds.fetch(
          {
            branchId,
            productUnitIds: chunk,
          },
          { staleTime: 0 },
        );
        if (cancelled || extra.branchId !== effectiveBranchId) return;
        dispatch({
          type: "SET_STOCK_SNAPSHOTS",
          queriedUnitIds: chunk,
          effectiveBranchId,
          snapshotsByUnitId: toSnapshotsByUnitId(extra.rows),
        });
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [liveStockQ.data, liveStockQ.dataUpdatedAt, branchId, allStockUnitIds, queryEnabled, dispatch]);
}
