import React from "react";
import { Printer, Search, Sun, Moon, Power, Globe, X, Vault } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { openCashDrawer, isWebUsbSupported } from "@/lib/printing/print";
import { notify } from "@/lib/notify";

const SHOP = "الرؤية العربية";
const DEPT = "قسم الطباعة والاستنساخ";
const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");

export interface PrintPosHeaderActionsProps {
  C: Record<string, string>;
  shiftId: number;
  userRole?: string | null;
  onCloseShift: () => void;
  printerReady: boolean;
  onConnectPrinter: () => void;
  bridgeEnabled: boolean;
  bridgeDesc: string;
  onTestPrint: () => void;
}

export function PrintPosHeaderActions({
  C,
  shiftId,
  userRole,
  onCloseShift,
  printerReady,
  onConnectPrinter,
  bridgeEnabled,
  bridgeDesc,
  onTestPrint,
}: PrintPosHeaderActionsProps) {
  return (
    <>
      <span className="inline-flex h-[var(--ui-control)] shrink-0 items-center rounded-lg border bg-muted/40 px-2.5 text-xs font-bold text-muted-foreground">
        <span aria-hidden className="me-1.5 size-2 rounded-full bg-[var(--sem-pos)]" />
        وردية #{shiftId}
      </span>
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

export interface PrintPosHeaderProps {
  C: Record<string, string>;
  dark: boolean;
  toggleDark: () => void;
  search: string;
  setSearch: (s: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  lastInv: { num: string; total: number } | null;
}

export function PrintPosHeader({
  C,
  dark,
  toggleDark,
  search,
  setSearch,
  searchRef,
  lastInv,
}: PrintPosHeaderProps) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "7px 14px", minHeight: 64, flexShrink: 0, background: C.card, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 40 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: C.primary, color: C.primaryFg, display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden>
          <Printer size={20} />
        </div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, lineHeight: 1.2, color: C.fg }}>{SHOP}</div>
          <div style={{ fontSize: 11, color: C.mutedFg, lineHeight: 1.3 }}>{DEPT}</div>
        </div>
      </div>
      <div style={{ width: 1, height: 28, background: C.border, flexShrink: 0 }} />
      <div style={{ flex: "1 1 460px", minWidth: 240, position: "relative", display: "flex", alignItems: "center" }}>
        <span style={{ position: "absolute", right: 13, color: C.mutedFg, pointerEvents: "none", display: "flex", alignItems: "center" }} aria-hidden>
          <Search size={16} />
        </span>
        <input
          ref={searchRef}
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ابحث عن خدمة بالاسم أو الرمز… (F2)"
          style={{ width: "100%", height: 46, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 14, outline: "none", paddingRight: 42, paddingLeft: search ? 36 : 14 }}
          onFocus={(e) => (e.target.style.borderColor = C.primary)}
          onBlur={(e) => (e.target.style.borderColor = C.border)}
        />
        {search && (
          <button onClick={() => setSearch("")} aria-label="مسح البحث" style={{ position: "absolute", left: 8, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, padding: 4, display: "inline-flex" }}>
            <X aria-hidden size={15} />
          </button>
        )}
      </div>
      {lastInv && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, background: C.primarySoft, border: `1px solid ${C.primary}`, borderRadius: 9, padding: "3px 6px 3px 13px", flexShrink: 0, lineHeight: 1.3 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: C.mutedFg, fontWeight: 600 }}>آخر فاتورة</span>
            <span style={{ fontSize: 15, fontWeight: 900, direction: "ltr", color: C.primary }}>{fmt(lastInv.total)} د.ع</span>
            <span style={{ fontSize: 9.5, color: C.mutedFg }}>{lastInv.num}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <CopyButton value={lastInv.num} title="نسخ رقم آخر فاتورة" successMessage="تم نسخ رقم الفاتورة" />
            <CopyButton value={lastInv.total} title="نسخ إجمالي آخر فاتورة" successMessage="تم نسخ الإجمالي" />
          </div>
        </div>
      )}
      <button onClick={toggleDark} title="تبديل الوضع الليلي" aria-label="تبديل الوضع الليلي" style={{ width: 42, height: 42, borderRadius: 9, background: "none", border: `1.5px solid ${C.border}`, cursor: "pointer", color: C.fg, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
      </button>
    </div>
  );
}
