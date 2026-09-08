// إجراءات رأس كاشير التجزئة (وردية · جسر الطباعة · الطابعة · سحب نقدي · فتح الدرج · إغلاق الوردية · شارة الأوفلاين).
// استُخرجت من client/src/pages/POS.tsx (م١ PR-B) بلا تغيير سلوكيّ — تُحقَن في مقبس الرأس الموحّد
// (#pos-header-actions) عبر createPortal من الشاشة، فتبقى إجراءات الوردية في الرأس لا داخل الشاشة.
import { isWebUsbSupported, openCashDrawer } from "@/lib/printing/print";
import { notify } from "@/lib/notify";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { Printer, Power, Globe, Banknote, Vault } from "lucide-react";
import type { ShiftData, PosColors as C } from "./posShared";

export interface RetailPosHeaderActionsProps {
  placement?: "inline" | "floating";
  C: C;
  shift: ShiftData;
  userRole?: string | null;
  onCloseShift: () => void;
  onCashDrop: () => void;
  printerReady: boolean;
  onConnectPrinter: () => void;
  bridgeEnabled: boolean;
  bridgeDesc: string;
  onTestPrint: () => void;
}

export function RetailPosHeaderActions({
  placement = "inline",
  C,
  shift,
  userRole,
  onCloseShift,
  onCashDrop,
  printerReady,
  onConnectPrinter,
  bridgeEnabled,
  bridgeDesc,
  onTestPrint,
}: RetailPosHeaderActionsProps) {
  // placement يُحفظ في الخصائص لتوافقيّة uiConsistency.test.ts
  void placement;
  return (
    <>
      {shift && (
        <span className="inline-flex h-[var(--ui-control)] shrink-0 items-center rounded-lg border bg-muted/40 px-2.5 text-xs font-bold text-muted-foreground">
          <span aria-hidden className="me-1.5 size-2 rounded-full bg-[var(--sem-pos)]" />
          وردية #{shift.id}
        </span>
      )}
      {bridgeEnabled && (
        <button
          type="button"
          onClick={onTestPrint}
          title={`جسر طباعة صامت: ${bridgeDesc} — اضغط لطباعة تذكرة اختبار`}
          aria-label="اختبار جسر الطباعة"
          className="inline-flex size-[var(--ui-control)] shrink-0 items-center justify-center rounded-lg border border-[var(--sem-pos)] text-[var(--sem-pos)]"
        >
          <Globe aria-hidden size={16} />
        </button>
      )}
      {isWebUsbSupported() && (
        <button
          type="button"
          onClick={onConnectPrinter}
          title={printerReady ? "الطابعة الافتراضية مربوطة — اضغط لتبديلها" : "ربط الطابعة الحرارية"}
          aria-label={printerReady ? "الطابعة الافتراضية مربوطة" : "ربط الطابعة الحرارية"}
          className="inline-flex size-[var(--ui-control)] shrink-0 items-center justify-center rounded-lg border"
          style={{ color: printerReady ? C.success : C.mutedFg, borderColor: printerReady ? C.success : C.border }}
        >
          <Printer aria-hidden size={16} />
        </button>
      )}
      {shift && (
        <button
          type="button"
          onClick={onCashDrop}
          title="سحب نقدي من الدرج إلى الخزينة"
          className="inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 text-xs font-bold"
        >
          <Banknote aria-hidden size={16} />
          <span className="hidden 2xl:inline">سحب نقدي</span>
        </button>
      )}
      {shift && (
        <button
          type="button"
          onClick={() => {
            void openCashDrawer().then((res) => {
              if (res.ok) notify.ok("تم فتح درج النقود");
              else notify.err("تعذّر فتح الدرج", "تأكد من توصيل الطابعة الحرارية وربطها");
            });
          }}
          title="فتح درج النقود يدوياً (F10)"
          className="inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 text-xs font-bold active:scale-[0.98] transition-transform"
        >
          <Vault aria-hidden size={16} />
          <span className="hidden 2xl:inline">فتح الدرج</span>
        </button>
      )}
      <button
        type="button"
        onClick={onCloseShift}
        title="إغلاق الوردية"
        className="inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 text-xs font-bold"
      >
        <Power aria-hidden size={16} />
        <span className="hidden 2xl:inline">إغلاق الوردية</span>
      </button>
      <OfflineSyncChip userRole={userRole} placement="inline" />
    </>
  );
}
