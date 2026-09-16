import React, { useState } from "react";
import {
  Printer,
  Search,
  Sun,
  Moon,
  Power,
  Globe,
  X,
  Vault,
  User,
  Phone,
  MessageCircle,
  Send,
  Clock,
} from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { openCashDrawer, isWebUsbSupported } from "@/lib/printing/print";
import { notify } from "@/lib/notify";
import { PrintCustomerCombo } from "@/components/printPos/PrintCustomerCombo";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import type { OrderChannel } from "./PrintChannelCustomerBar";

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
  channel: OrderChannel;
  setChannel: (c: OrderChannel) => void;
  customerId: number | null;
  setCustomerId: (id: number | null) => void;
  contactName: string;
  setContactName: (name: string) => void;
  contactPhone: string;
  setContactPhone: (phone: string) => void;
  heldCount: number;
  onOpenHeldDrawer: () => void;
}

export function PrintPosHeader({
  C,
  dark,
  toggleDark,
  search,
  setSearch,
  searchRef,
  lastInv,
  channel,
  setChannel,
  customerId,
  setCustomerId,
  contactName,
  setContactName,
  contactPhone,
  setContactPhone,
  heldCount,
  onOpenHeldDrawer,
}: PrintPosHeaderProps) {
  const [customerMode, setCustomerMode] = useState<"REGISTERED" | "GUEST">(
    customerId != null ? "REGISTERED" : "GUEST",
  );

  const channels: Array<{ id: OrderChannel; label: string; icon: React.ComponentType<{ className?: string; size?: number }> }> = [
    { id: "WALK_IN", label: "حاضر", icon: User },
    { id: "WHATSAPP", label: "واتساب", icon: MessageCircle },
    { id: "TELEGRAM", label: "تليغرام", icon: Send },
    { id: "PHONE", label: "هاتف", icon: Phone },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        minHeight: 52,
        flexShrink: 0,
        background: C.card,
        borderBottom: `1px solid ${C.border}`,
        position: "relative",
        zIndex: 40,
        direction: "rtl",
        boxSizing: "border-box",
      }}
    >
      {/* ── الشعار واسم القسم ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: C.primary,
            color: C.primaryFg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-hidden
        >
          <Printer size={18} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.2, color: C.fg }}>{SHOP}</div>
          <div style={{ fontSize: 10.5, color: C.mutedFg, lineHeight: 1.2 }}>{DEPT}</div>
        </div>
      </div>

      {/* فاصل */}
      <div style={{ width: 1, height: 26, background: C.border, flexShrink: 0 }} />

      {/* ── حقل البحث المختصر ── */}
      <div
        style={{
          width: 230,
          flexShrink: 0,
          position: "relative",
          display: "flex",
          alignItems: "center",
        }}
      >
        <span
          style={{
            position: "absolute",
            right: 10,
            color: C.mutedFg,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
          }}
          aria-hidden
        >
          <Search size={15} />
        </span>
        <input
          ref={searchRef}
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث عن خدمة… (F2)"
          style={{
            width: "100%",
            height: 34,
            border: `1.5px solid ${C.border}`,
            borderRadius: 8,
            background: C.card,
            color: C.fg,
            fontFamily: "inherit",
            fontSize: 12.5,
            outline: "none",
            paddingRight: 34,
            paddingLeft: search ? 28 : 10,
            boxSizing: "border-box",
          }}
          onFocus={(e) => (e.target.style.borderColor = C.primary)}
          onBlur={(e) => (e.target.style.borderColor = C.border)}
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            aria-label="مسح البحث"
            style={{
              position: "absolute",
              left: 6,
              background: "none",
              border: "none",
              cursor: "pointer",
              color: C.mutedFg,
              padding: 2,
              display: "inline-flex",
            }}
          >
            <X aria-hidden size={14} />
          </button>
        )}
      </div>

      {/* فاصل */}
      <div style={{ width: 1, height: 26, background: C.border, flexShrink: 0 }} />

      {/* ── قنوات العميل ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.mutedFg, whiteSpace: "nowrap" }}>
          القناة:
        </span>
        <div style={{ display: "flex", gap: 2, background: C.muted, padding: 2, borderRadius: 7 }}>
          {channels.map((ch) => {
            const Icon = ch.icon;
            const active = channel === ch.id;
            return (
              <button
                key={ch.id}
                type="button"
                onClick={() => setChannel(ch.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3.5,
                  height: 26,
                  minHeight: 0,
                  padding: "0 7px",
                  borderRadius: 5,
                  border: "none",
                  background: active ? C.primary : "transparent",
                  color: active ? "#fff" : C.fg,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "all 0.15s ease",
                  whiteSpace: "nowrap",
                }}
              >
                <Icon size={12} />
                <span>{ch.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* فاصل */}
      <div style={{ width: 1, height: 26, background: C.border, flexShrink: 0 }} />

      {/* ── وضع العميل وبياناته (هاتف واسم / عميل مسجل) ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 2, background: C.muted, padding: 2, borderRadius: 7, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => {
              setCustomerMode("GUEST");
              setCustomerId(null);
            }}
            style={{
              height: 26,
              minHeight: 0,
              padding: "0 8px",
              borderRadius: 5,
              border: "none",
              background: customerMode === "GUEST" ? C.primary : "transparent",
              color: customerMode === "GUEST" ? "#fff" : C.fg,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            عابر
          </button>
          <button
            type="button"
            onClick={() => setCustomerMode("REGISTERED")}
            style={{
              height: 26,
              minHeight: 0,
              padding: "0 8px",
              borderRadius: 5,
              border: "none",
              background: customerMode === "REGISTERED" ? C.primary : "transparent",
              color: customerMode === "REGISTERED" ? "#fff" : C.fg,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            مسجل
          </button>
        </div>

        {customerMode === "REGISTERED" ? (
          <div style={{ width: 210, flexShrink: 0 }}>
            <PrintCustomerCombo C={C as any} customerId={customerId} setCustomerId={setCustomerId} />
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
            <div style={{ width: 155, flexShrink: 0 }}>
              <IntlPhoneInput
                value={contactPhone}
                onChange={setContactPhone}
                placeholder="770..."
                ariaLabel="هاتف الزبون"
                className="h-[30px] text-xs w-full"
              />
            </div>
            <input
              type="text"
              placeholder="اسم الزبون"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              style={{
                width: 105,
                height: 30,
                padding: "0 8px",
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: C.card,
                color: C.fg,
                fontSize: 11.5,
                fontFamily: "inherit",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}
      </div>

      {/* فاصل */}
      <div style={{ width: 1, height: 26, background: C.border, flexShrink: 0 }} />

      {/* ── زر المحجوزات ── */}
      <button
        type="button"
        onClick={onOpenHeldDrawer}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 28,
          minHeight: 0,
          padding: "0 8px",
          borderRadius: 6,
          border: `1.5px solid ${heldCount > 0 ? "var(--sem-warn, #f59e0b)" : C.border}`,
          background: heldCount > 0 ? "rgba(245, 158, 11, 0.12)" : C.muted,
          color: heldCount > 0 ? "var(--sem-warn, #d97706)" : C.fg,
          fontSize: 11.5,
          fontWeight: 800,
          cursor: "pointer",
          fontFamily: "inherit",
          flexShrink: 0,
          whiteSpace: "nowrap",
          transition: "all 0.15s ease",
        }}
        title="عرض الطلبات المحجوزة والمعلقة"
      >
        <Clock size={13} />
        <span>المحجوزات</span>
        {heldCount > 0 && (
          <span
            style={{
              background: "var(--sem-warn, #f59e0b)",
              color: "#fff",
              borderRadius: 10,
              padding: "0 5px",
              fontSize: 10,
              fontWeight: 900,
              lineHeight: "14px",
            }}
          >
            {heldCount}
          </span>
        )}
      </button>

      {/* مساحة مرنة تفصل العناصر اليمنى عن اليسرى */}
      <div style={{ flex: 1, minWidth: 10 }} />

      {/* ── آخر فاتورة ── */}
      {lastInv && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: C.primarySoft,
            border: `1px solid ${C.primary}`,
            borderRadius: 7,
            padding: "2px 6px 2px 10px",
            flexShrink: 0,
            lineHeight: 1.2,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: 9.5, color: C.mutedFg, fontWeight: 600 }}>آخر فاتورة</span>
            <span style={{ fontSize: 13.5, fontWeight: 900, direction: "ltr", color: C.primary }}>
              {fmt(lastInv.total)} د.ع
            </span>
            <span style={{ fontSize: 9, color: C.mutedFg }}>{lastInv.num}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <CopyButton value={lastInv.num} title="نسخ رقم آخر فاتورة" successMessage="تم نسخ رقم الفاتورة" />
            <CopyButton value={lastInv.total} title="نسخ إجمالي آخر فاتورة" successMessage="تم نسخ الإجمالي" />
          </div>
        </div>
      )}

      {/* ── تبديل الوضع الليلي ── */}
      <button
        onClick={toggleDark}
        title="تبديل الوضع الليلي"
        aria-label="تبديل الوضع الليلي"
        style={{
          width: 34,
          height: 34,
          borderRadius: 8,
          background: "none",
          border: `1.5px solid ${C.border}`,
          cursor: "pointer",
          color: C.fg,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
      </button>
    </div>
  );
}
