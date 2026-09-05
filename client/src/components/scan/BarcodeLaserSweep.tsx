import { motion, AnimatePresence } from "framer-motion";

export interface BarcodeLaserSweepProps {
  active: boolean;
  color?: "red" | "green" | "cyan";
  label?: string;
  onAnimationComplete?: () => void;
}

export function BarcodeLaserSweep({
  active,
  color = "red",
  label,
  onAnimationComplete,
}: BarcodeLaserSweepProps) {
  const beamColor =
    color === "green"
      ? "rgb(34, 197, 94)"
      : color === "cyan"
      ? "rgb(6, 182, 212)"
      : "rgb(239, 68, 68)";

  const glowShadow =
    color === "green"
      ? "0 0 12px 2px rgba(34, 197, 94, 0.8), 0 0 24px 6px rgba(34, 197, 94, 0.4)"
      : color === "cyan"
      ? "0 0 12px 2px rgba(6, 182, 212, 0.8), 0 0 24px 6px rgba(6, 182, 212, 0.4)"
      : "0 0 12px 2px rgba(239, 68, 68, 0.8), 0 0 24px 6px rgba(239, 68, 68, 0.4)";

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            pointerEvents: "none",
            zIndex: 30,
            borderRadius: "inherit",
          }}
        >
          {/* وميض الخلفية الخفيف عند بدء المسح */}
          <motion.div
            initial={{ opacity: 0.15 }}
            animate={{ opacity: [0.15, 0.35, 0] }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            style={{
              position: "absolute",
              inset: 0,
              background: beamColor,
            }}
          />

          {/* خط شعاع الليزر المتحرك عمودياً */}
          <motion.div
            initial={{ top: "0%" }}
            animate={{ top: ["0%", "100%", "40%"] }}
            transition={{
              duration: 0.65,
              ease: "easeInOut",
            }}
            onAnimationComplete={onAnimationComplete}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              height: 2.5,
              background: beamColor,
              boxShadow: glowShadow,
            }}
          />

          {/* نص التأكيد عند نجاح القراءة */}
          {label && (
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.25 }}
              style={{
                position: "absolute",
                bottom: 8,
                left: "50%",
                transform: "translateX(-50%)",
                background: "rgba(15, 23, 42, 0.85)",
                color: "#ffffff",
                padding: "2px 10px",
                borderRadius: 9999,
                fontSize: 11,
                fontWeight: 700,
                backdropFilter: "blur(4px)",
                border: `1px solid ${beamColor}`,
                whiteSpace: "nowrap",
                direction: "rtl",
              }}
            >
              {label}
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
