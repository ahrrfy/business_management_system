import { useState } from "react";
import {
  User,
  Phone,
  MessageCircle,
  Send,
  Building2,
  Clock,
  ChevronDown,
  UserCheck,
} from "lucide-react";
import { PrintCustomerCombo } from "@/components/printPos/PrintCustomerCombo";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";

export type OrderChannel = "WALK_IN" | "WHATSAPP" | "TELEGRAM" | "PHONE";

interface PrintChannelCustomerBarProps {
  C: {
    card: string;
    border: string;
    primary: string;
    primarySoft: string;
    muted: string;
    mutedFg: string;
    fg: string;
  };
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

export function PrintChannelCustomerBar({
  C,
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
}: PrintChannelCustomerBarProps) {
  const [customerMode, setCustomerMode] = useState<"REGISTERED" | "GUEST">(
    customerId != null ? "REGISTERED" : "GUEST",
  );

  const channels: Array<{ id: OrderChannel; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: "WALK_IN", label: "حاضر", icon: User },
    { id: "WHATSAPP", label: "واتساب", icon: MessageCircle },
    { id: "TELEGRAM", label: "تليغرام", icon: Send },
    { id: "PHONE", label: "هاتف", icon: Phone },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "5px 8px",
        background: C.card,
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        flexShrink: 0,
        width: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      {/* الصف الأول: أزرار القناة + زر المحجوزات */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          width: "100%",
        }}
      >
        {/* اختيار القناة */}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.mutedFg, flexShrink: 0 }}>القناة:</span>
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
                  <Icon className="size-3" />
                  <span>{ch.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* زر الطلبات المحجوزة بعدّاد */}
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
          <Clock className="size-3.5" />
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
      </div>

      {/* فاصل هادئ بين الصفين */}
      <div style={{ height: 1, background: C.border, opacity: 0.6 }} />

      {/* الصف الثاني: تحديد وضع العميل وبياناته */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
        }}
      >
        {/* محول وضع العميل */}
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
              fontSize: 11.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            زبون عابر
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
              fontSize: 11.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            عميل مسجل
          </button>
        </div>

        {/* حقول بيانات العميل */}
        {customerMode === "REGISTERED" ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <PrintCustomerCombo C={C} customerId={customerId} setCustomerId={setCustomerId} />
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0 }}>
            <input
              type="text"
              placeholder="اسم الزبون"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              style={{
                height: 32,
                flex: "1 1 90px",
                minWidth: 0,
                padding: "0 8px",
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: C.card,
                color: C.fg,
                fontSize: 12,
                fontFamily: "inherit",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <div style={{ flex: "1.4 1 120px", minWidth: 0 }}>
              <IntlPhoneInput
                value={contactPhone}
                onChange={setContactPhone}
                placeholder="770..."
                ariaLabel="هاتف الزبون"
                className="h-[32px] text-xs w-full"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
