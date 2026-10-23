import { useCallback } from "react";
import { type CustomizationData } from "@/components/CustomizationDialog";
import { receptionCheckoutPaths } from "@/lib/receptionOperationAccess";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { type DigitalBasketCapture } from "@/components/pos/DigitalCardsPickerDialog";
import { captureDigitalReceptionCartLines } from "@/components/pos/digitalBasket";
import { updateRestoredReceptionCustomization } from "@/lib/receptionWorkspaceState";
import {
  isCustomKind,
  TIER_LABEL,
  type CartLine,
  type PosRow,
  type Tier,
} from "@/components/reception/cartMath";
import { addPlainCustomizationPiece } from "@/components/reception/cartCustomization";
export interface useReceptionCartEditingInput {
  clearCouponIfApplied: () => void;
  setCart: React.Dispatch<
    React.SetStateAction<import("@/components/reception/cartMath").CartLine[]>
  >;
  setSelKey: React.Dispatch<React.SetStateAction<string | null>>;
  setAddTick: React.Dispatch<React.SetStateAction<number>>;
  canActionRef: React.RefObject<(path: string) => boolean>;
  offline: boolean;
  activeDraft: { id: number; version: number } | null;
  branchId: number;
  setInvoiceDiscountPct: React.Dispatch<React.SetStateAction<string>>;
  setCardsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  effectiveTier: import("@/components/reception/cartMath").Tier;
  setShowCustomization: React.Dispatch<
    React.SetStateAction<{
      row: import("@/components/reception/cartMath").PosRow;
      editingKey?: string | undefined;
    } | null>
  >;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  setShowDrop: React.Dispatch<React.SetStateAction<boolean>>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  showCustomization: {
    row: import("@/components/reception/cartMath").PosRow;
    editingKey?: string | undefined;
  } | null;
  cartSectionRef: React.RefObject<HTMLDivElement | null>;
  selKey: string | null;
}
export function useReceptionCartEditing({
  clearCouponIfApplied,
  setCart,
  setSelKey,
  setAddTick,
  canActionRef,
  offline,
  activeDraft,
  branchId,
  setInvoiceDiscountPct,
  setCardsOpen,
  effectiveTier,
  setShowCustomization,
  setSearch,
  setShowDrop,
  searchRef,
  showCustomization,
  cartSectionRef,
  selKey,
}: useReceptionCartEditingInput) {
  const addDirectLine = useCallback(
    (row: PosRow) => {
      clearCouponIfApplied();
      setCart((prev) => {
        // دمج كميّات الصنف الجاهز المُكرَّر وتصعيده لقمة السلة ليبقى في متناول يد ونظر الكاشير
        const i = prev.findIndex(
          (c) =>
            !c.digital &&
            !isCustomKind(c) &&
            c.row.productUnitId === row.productUnitId,
        );
        if (i >= 0) {
          const next = [...prev];
          const updated = { ...next[i], qty: next[i].qty + 1 };
          next.splice(i, 1);
          next.unshift(updated);
          setSelKey(updated.key);
          return next;
        }
        const key = `d-${row.productUnitId}-${Date.now()}`;
        setSelKey(key);
        return [{ key, row, qty: 1 }, ...prev];
      });
      // ٢٣/٨ (Codex P2): أشِر إلى الجدول أنّ إضافةً حدثت — يشمل رفع الكمّية على السطر الأصل.
      setAddTick((t) => t + 1);
    },
    [clearCouponIfApplied],
  );

  function addDigitalBasket(basket: DigitalBasketCapture) {
    if (!receptionCheckoutPaths(true, false, false).every(canActionRef.current))
      return notify.err("تفويضات البيع الرقمي غير مكتملة");
    if (offline) return notify.err("البيع الرقمي يحتاج اتصالاً بالخادم.");
    if (activeDraft)
      return notify.err(
        "لا تُضاف الكروت إلى طلب محفوظ؛ ثبّت الطلب أو افتح سلة جديدة.",
      );
    try {
      const captured = captureDigitalReceptionCartLines(
        basket,
        branchId,
      ) as CartLine[];
      clearCouponIfApplied();
      setInvoiceDiscountPct("");
      setCart((previous) => [...captured, ...previous]);
      setSelKey(captured[0]?.digital?.lineKey ?? null);
      setAddTick((tick) => tick + 1);
      setCardsOpen(false);
    } catch (error) {
      notify.err(error);
    }
  }

  const addRow = useCallback(
    (row: PosRow) => {
      // إصلاح P2 (٢٣/٦/٢٦): حارس السعر **قبل** فتح نافذة التخصيص — كان يَسمح لمخصَّصٍ بلا سعرٍ
      // بالدخول للسلّة ثم يَفشل عند الإرسال (createWorkOrder يَرفض salePrice<=0) بَعد ما اَلتزَمت
      // فاتورة البيع — رحلةٌ بِنصف نتيجة. الحارس موحَّد للنوعين.
      if (row.price == null || Number(row.price) <= 0) {
        notify.err(
          `لا سعر ${TIER_LABEL[effectiveTier]} لـ ${row.productName} (${row.unitName}) — حدّد سعراً من /products أوّلاً`,
        );
        return;
      }
      // المنتج المخصّص (products.isCustomizable=true) ⇒ افتح نافذة التخصيص (وفيها خيار «بلا تخصيص»
      // لعميلٍ يريد القطعة كما هي — انظر onAddPlain أدناه، إصلاح ٣/٨).
      if (row.isCustomizable) {
        setShowCustomization({ row });
        setSearch("");
        setShowDrop(false);
        return;
      }
      addDirectLine(row);
      setSearch("");
      setShowDrop(false);
      searchRef.current?.focus();
    },
    [addDirectLine, effectiveTier],
  );

  /** خدمة حرة كانت تُنشأ من صفحة «طلب خدمة جديد». أصبحت الآن سطراً داخل السلة نفسها. */
  function addManualService() {
    const row = {
      variantId: 0,
      productUnitId: 0,
      productName: "خدمة / أمر شغل",
      sku: "SERVICE",
      unitName: "خدمة",
      conversionFactor: "1",
      price: "0",
      stockBase: 0,
      isService: true,
      isPrintService: false,
      isCustomizable: true,
    } as PosRow;
    setShowCustomization({ row });
    setSearch("");
    setShowDrop(false);
  }

  function saveCustomization(data: CustomizationData) {
    if (!showCustomization) return;
    const { row, editingKey } = showCustomization;
    if (editingKey) {
      setCart((prev) =>
        prev.map((c) =>
          c.key === editingKey
            ? updateRestoredReceptionCustomization(c, data)
            : c,
        ),
      );
    } else {
      const key = `c-${row.productUnitId}-${Date.now()}`;
      setCart((prev) => [
        {
          key,
          row,
          qty: 1,
          custom: data,
          customBasePrice: D(row.price).toNumber(),
          manualService: row.variantId === 0,
        },
        ...prev,
      ]);
      setSelKey(key);
    }
    setShowCustomization(null);
    requestAnimationFrame(() => cartSectionRef.current?.focus());
  }

  /** تبديل وحدة الصنف مع الرفع التلقائي للسعر والمعامل ومطابقة المخزون. */
  const changeLineUnit = useCallback(
    (lineKey: string, newRow: PosRow) => {
      clearCouponIfApplied();
      setCart((prev) =>
        prev.map((c) => {
          if (c.key !== lineKey) return c;
          if (c.digital) return c;
          const { origPrice: _oldUnitPrice, ...rest } = c;
          return {
            ...rest,
            row: {
              ...newRow,
              isCustomizable: c.row.isCustomizable,
            },
            disc: undefined,
          };
        }),
      );
    },
    [clearCouponIfApplied],
  );

  function changeQty(key: string, delta: number) {
    clearCouponIfApplied();
    setCart((prev) =>
      prev.map((c) =>
        c.key === key && !c.digital
          ? { ...c, qty: Math.max(1, c.qty + delta) }
          : c,
      ),
    );
  }
  function addPlainFromCustomization(key: string) {
    clearCouponIfApplied();
    const plainKey = `d-${crypto.randomUUID()}`;
    setCart((prev) => addPlainCustomizationPiece(prev, key, plainKey));
    setSelKey(plainKey);
    setAddTick((tick) => tick + 1);
  }
  function removeRow(key: string) {
    clearCouponIfApplied();
    setCart((prev) => prev.filter((c) => c.key !== key));
    if (selKey === key) setSelKey(null);
  }

  return {
    addRow,
    addManualService,
    changeQty,
    removeRow,
    addPlainFromCustomization,
    changeLineUnit,
    addDirectLine,
    saveCustomization,
    addDigitalBasket,
  };
}
