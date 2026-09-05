import { motion } from "framer-motion";
import { Vault, Check, ArrowDown } from "lucide-react";

export interface VirtualCashDrawerProps {
  isOpen: boolean;
  onToggle: () => void;
}

/**
 * محاكاة بصرية لميكانيكية درج النقود (Cash Drawer) لنقطة البيع.
 * تفتح بحركة انزلاق سلسة مع تأثير زنبركي (Spring physics) بالتزامن مع طباعة الفاتورة.
 */
export function VirtualCashDrawer({ isOpen, onToggle }: VirtualCashDrawerProps) {
  return (
    <div
      style={{
        width: "100%",
        marginTop: 10,
        position: "relative",
        userSelect: "none",
        cursor: "pointer",
      }}
      onClick={onToggle}
      title="اضغط لفتح أو إغلاق درج النقود"
    >
      {/* هيكل الدرج الخارجي الثابت (Chassis / Housing) */}
      <div
        style={{
          width: "100%",
          background: "linear-gradient(180deg, #1e293b 0%, #0f172a 100%)",
          border: "2px solid #334155",
          borderRadius: 12,
          padding: "10px 14px",
          boxShadow: "0 10px 25px rgba(0,0,0,0.45)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* شريط معلومات حالة الدرج العلوي */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 12,
            fontWeight: 800,
            color: "#94a3b8",
            marginBottom: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Vault size={16} color={isOpen ? "#22c55e" : "#94a3b8"} />
            <span style={{ color: isOpen ? "#4ade80" : "#cbd5e1" }}>
              {isOpen ? "درج النقود (مفتوح)" : "درج النقود (مغلق)"}
            </span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: isOpen ? "rgba(34,197,94,0.15)" : "rgba(100,116,139,0.15)",
              border: `1px solid ${isOpen ? "rgba(34,197,94,0.4)" : "rgba(100,116,139,0.3)"}`,
              padding: "2px 8px",
              borderRadius: 6,
              fontSize: 11,
              color: isOpen ? "#4ade80" : "#94a3b8",
            }}
          >
            {isOpen ? <Check size={12} strokeWidth={3} /> : <ArrowDown size={12} />}
            <span>{isOpen ? "تم الفتح تلقائياً" : "اضغط للفتح F10"}</span>
          </div>
        </div>

        {/* صينية درج النقود المنزلقة (The Sliding Cash Tray) */}
        <motion.div
          initial={false}
          animate={
            isOpen
              ? { y: 0, scale: 1, opacity: 1 }
              : { y: -8, scale: 0.98, opacity: 0.85 }
          }
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          style={{
            background: "#090d16",
            border: "1.5px solid #1e293b",
            borderRadius: 8,
            padding: "8px 10px",
            boxShadow: isOpen
              ? "inset 0 4px 12px rgba(0,0,0,0.8), 0 4px 16px rgba(34,197,94,0.15)"
              : "inset 0 2px 8px rgba(0,0,0,0.6)",
          }}
        >
          {/* مقاطع الأوراق النقدية مع المشابك المعدنية (Bill Compartments) */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 6,
              marginBottom: 6,
            }}
          >
            {["25,000", "10,000", "5,000", "1,000/250"].map((label, idx) => (
              <div
                key={idx}
                style={{
                  height: 38,
                  background: "linear-gradient(180deg, #1e293b 0%, #151e2e 100%)",
                  border: "1px solid #334155",
                  borderRadius: 5,
                  position: "relative",
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "center",
                  paddingBottom: 4,
                }}
              >
                {/* مشبك الورق المعدني (Spring Bill Clip) */}
                <div
                  style={{
                    position: "absolute",
                    top: 2,
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: 14,
                    height: 18,
                    background: "linear-gradient(180deg, #94a3b8 0%, #475569 100%)",
                    borderRadius: "0 0 4px 4px",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.5)",
                  }}
                />
                <span
                  style={{
                    fontSize: 9.5,
                    fontFamily: "monospace",
                    fontWeight: 700,
                    color: isOpen ? "#38bdf8" : "#64748b",
                    direction: "ltr",
                  }}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>

          {/* خانات الفكة والعملات المعدنية (Coin Scoops) */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 6,
            }}
          >
            {[1, 2, 3, 4].map((c) => (
              <div
                key={c}
                style={{
                  height: 20,
                  background: "radial-gradient(ellipse at center, #1e293b 0%, #0b1120 100%)",
                  border: "1px solid #1e293b",
                  borderRadius: "3px 3px 8px 8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: isOpen ? "#f59e0b" : "#475569",
                    opacity: 0.7,
                    boxShadow: isOpen ? "0 0 6px rgba(245,158,11,0.6)" : "none",
                  }}
                />
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
