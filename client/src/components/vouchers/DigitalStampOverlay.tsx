import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { useEffect } from "react";

export interface DigitalStampOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  referenceNumber?: string;
  actorName?: string;
  variant?: "approved" | "completed" | "audited";
  durationMs?: number;
}

export function DigitalStampOverlay({
  isOpen,
  onClose,
  title = "مُعتمَد رسمياً",
  subtitle = "نظام إدارة الرؤية العربية",
  referenceNumber,
  actorName,
  variant = "approved",
  durationMs = 2400,
}: DigitalStampOverlayProps) {
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      onClose();
    }, durationMs);
    return () => clearTimeout(timer);
  }, [isOpen, durationMs, onClose]);

  const isGreen = variant === "approved" || variant === "completed";
  const primaryColor = isGreen ? "#15803d" : "#0284c7";
  const bgBadge = isGreen ? "rgba(240, 253, 244, 0.95)" : "rgba(240, 249, 255, 0.95)";
  const borderColor = isGreen ? "#16a34a" : "#0284c7";

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(15, 23, 42, 0.45)",
            backdropFilter: "blur(4px)",
            cursor: "pointer",
            direction: "rtl",
            fontFamily: "'Cairo', system-ui, sans-serif",
          }}
        >
          {/* الختم الرقمي الدائري المنطبع بقوة */}
          <motion.div
            initial={{ scale: 2.5, rotate: -25, opacity: 0 }}
            animate={{ scale: 1, rotate: -8, opacity: 1 }}
            exit={{ scale: 0.85, opacity: 0 }}
            transition={{
              type: "spring",
              stiffness: 280,
              damping: 14,
              mass: 0.8,
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "relative",
              width: 260,
              height: 260,
              borderRadius: "50%",
              border: `5px double ${borderColor}`,
              boxShadow: `0 0 0 4px rgba(22, 163, 74, 0.15), 0 20px 40px rgba(0, 0, 0, 0.35)`,
              background: bgBadge,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              textAlign: "center",
              color: primaryColor,
              userSelect: "none",
            }}
          >
            {/* الحلقة الداخلية المنقطة */}
            <div
              style={{
                position: "absolute",
                inset: 8,
                borderRadius: "50%",
                border: `1.5px dashed ${borderColor}`,
                pointerEvents: "none",
              }}
            />

            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              {isGreen ? (
                <CheckCircle2 size={24} strokeWidth={2.5} />
              ) : (
                <ShieldCheck size={24} strokeWidth={2.5} />
              )}
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.05em" }}>
                {subtitle}
              </span>
            </div>

            <div
              style={{
                fontSize: 22,
                fontWeight: 900,
                lineHeight: 1.1,
                letterSpacing: "0.08em",
                margin: "4px 0",
                textTransform: "uppercase",
                borderTop: `2px solid ${borderColor}`,
                borderBottom: `2px solid ${borderColor}`,
                padding: "4px 16px",
                width: "90%",
              }}
            >
              {title}
            </div>

            {referenceNumber && (
              <div
                style={{
                  fontSize: 12,
                  fontFamily: "monospace",
                  fontWeight: 800,
                  marginTop: 6,
                  color: "#0f172a",
                  direction: "ltr",
                }}
              >
                {referenceNumber}
              </div>
            )}

            {actorName && (
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#475569", marginTop: 4 }}>
                المعتمِد: {actorName}
              </div>
            )}

            <div style={{ fontSize: 9.5, color: "#64748b", marginTop: 4 }}>
              {new Date().toLocaleDateString("ar-IQ")} • {new Date().toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
