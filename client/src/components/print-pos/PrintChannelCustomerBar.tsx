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
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 10px",
        background: C.card,
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        marginBottom: 8,
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      {/* اختيار القناة */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.mutedFg, marginInlineEnd: 2 }}>القناة:</span>
        <div style={{ display: "flex", gap: 3, background: C.muted, padding: 2, borderRadius: 8 }}>
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
                  gap: 4,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "none",
                  background: active ? C.primary : "transparent",
                  color: active ? "#fff" : C.fg,
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  transition: "all 0.15s ease",
                }}
              >
                <Icon className="size-3.5" />
                <span>{ch.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* نوع العميل وبياناته */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" }}>
        <div style={{ display: "flex", gap: 3, background: C.muted, padding: 2, borderRadius: 8 }}>
          <button
            type="button"
            onClick={() => {
              setCustomerMode("GUEST");
              setCustomerId(null);
            }}
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              border: "none",
              background: customerMode === "GUEST" ? C.primary : "transparent",
              color: customerMode === "GUEST" ? "#fff" : C.fg,
              fontSize: 11.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            زبون عابر
          </button>
          <button
            type="button"
            onClick={() => setCustomerMode("REGISTERED")}
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              border: "none",
              background: customerMode === "REGISTERED" ? C.primary : "transparent",
              color: customerMode === "REGISTERED" ? "#fff" : C.fg,
              fontSize: 11.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            عميل مسجل
          </button>
        </div>

        {customerMode === "REGISTERED" ? (
          <div style={{ width: 200 }}>
            <PrintCustomerCombo C={C} customerId={customerId} setCustomerId={setCustomerId} />
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="text"
              placeholder="اسم الزبون"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              style={{
                height: 34,
                width: 110,
                padding: "0 8px",
                borderRadius: 7,
                border: `1px solid ${C.border}`,
                background: C.card,
                color: C.fg,
                fontSize: 12,
                fontFamily: "inherit",
                outline: "none",
              }}
            />
            <IntlPhoneInput
              value={contactPhone}
              onChange={setContactPhone}
              placeholder="770..."
              ariaLabel="هاتف الزبون"
              className="h-[34px] w-[170px] text-xs"
            />
          </div>
        )}

        {/* زر الطلبات المحجوزة بعدّاد */}
        <button
          type="button"
          onClick={onOpenHeldDrawer}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 34,
            padding: "0 10px",
            borderRadius: 7,
            border: `1.5px solid ${heldCount > 0 ? "var(--sem-warn, #f59e0b)" : C.border}`,
            background: heldCount > 0 ? "rgba(245, 158, 11, 0.1)" : C.muted,
            color: heldCount > 0 ? "var(--sem-warn, #d97706)" : C.fg,
            fontSize: 12,
            fontWeight: 800,
            cursor: "pointer",
            fontFamily: "inherit",
            marginInlineStart: 4,
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
                padding: "0 6px",
                fontSize: 10,
                fontWeight: 900,
              }}
            >
              {heldCount}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
