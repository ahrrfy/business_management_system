/**
 * مزامنة أرصدة المخزون الحيّة لمحرّرات الفواتير وعروض الأسعار المشتركة (`invoiceReducer`).
 *
 * تعالج ثلاث علل بنيوية في موضعٍ واحد:
 * 1) تثبيت مفتاح الوحدات نصّياً (`allStockUnitIdsKey`) بحيث لا تؤدي تحديثات السطور (كمية/سعر/خصم
 *    أو `SET_STOCK_SNAPSHOTS` نفسه) إلى كسر مرجع المصفوفة وإشعال حلقة `useEffect` لانهائية.
 * 2) دعم السلال الكبيرة (> 500 وحدة، سقف `catalog.stockByUnitIds`) عبر دفعات لاحقة آمنة محاطة
 *    بـ `Promise.allSettled` وبلا تخزين مؤقّت قديم (`staleTime: 0`) مع إعادة المحاولة عند كل نبضة
 *    `dataUpdatedAt` دون إسقاط الشاشة أو تصفير الوحدات التي تعثّر جلب دفعتها مؤقتاً.
 * 3) عزل `trpc.useUtils()` داخل `useRef` وحراسة `branchId > 0` و`productUnitId > 0` لمطابقة عقد الخادم.
 */
import { type Dispatch, useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import type { InvoiceAction, InvoiceLine } from "./types";

const STOCK_QUERY_CHUNK_SIZE = 500;

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

    if (allStockUnitIds.length <= STOCK_QUERY_CHUNK_SIZE) {
      dispatch({
        type: "SET_STOCK_SNAPSHOTS",
        queriedUnitIds: firstChunkIds,
        effectiveBranchId,
        snapshotsByUnitId: Object.fromEntries(
          baseRows.map((row) => [
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
        ),
      });
      return;
    }

    let cancelled = false;
    async function applyChunkedSnapshots() {
      const allRows = [...baseRows];
      const succeededUnitIds = new Set<number>(firstChunkIds);

      const extraChunks: number[][] = [];
      for (let i = STOCK_QUERY_CHUNK_SIZE; i < allStockUnitIds.length; i += STOCK_QUERY_CHUNK_SIZE) {
        extraChunks.push(allStockUnitIds.slice(i, i + STOCK_QUERY_CHUNK_SIZE));
      }

      const settled = await Promise.allSettled(
        extraChunks.map(async (chunk) => {
          const extra = await utilsRef.current.catalog.stockByUnitIds.fetch(
            {
              branchId,
              productUnitIds: chunk,
            },
            { staleTime: 0 },
          );
          return { chunk, branchId: extra.branchId, rows: extra.rows };
        }),
      );

      if (cancelled) return;

      for (const result of settled) {
        if (result.status === "fulfilled" && result.value.branchId === effectiveBranchId) {
          for (const id of result.value.chunk) succeededUnitIds.add(id);
          allRows.push(...result.value.rows);
        }
      }

      dispatch({
        type: "SET_STOCK_SNAPSHOTS",
        queriedUnitIds: succeededUnitIds,
        effectiveBranchId,
        snapshotsByUnitId: Object.fromEntries(
          allRows.map((row) => [
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
        ),
      });
    }

    void applyChunkedSnapshots();
    return () => {
      cancelled = true;
    };
  }, [liveStockQ.data, liveStockQ.dataUpdatedAt, branchId, allStockUnitIds, queryEnabled, dispatch]);
}
