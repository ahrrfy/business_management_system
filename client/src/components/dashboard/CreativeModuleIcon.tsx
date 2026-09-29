import React from "react";
import { motion } from "framer-motion";
import type { ApplicationModule } from "@/lib/moduleRegistry";
import { getIconHoverMotion } from "./moduleAnimations";

/**
 * مكون الشعار التفاعلي الذكي:
 * يدمج الحركات الفيزيائية المستمرة مع عناصر إبداعية تفاعلية مصغّرة (Micro-stories):
 * - سلة التسوق: دحرجة مع سقوط منتجات داخل السلة باستمرار
 * - التوصيل: انطلاق الشاحنة مع خطوط حركة الطريق السريعة تحت العجلات
 * - قارئ الأسعار: شعاع ليزر ضوئي يمسح الباركود صعوداً وهبوطاً
 * - المطبعة والإنتاج: رأس الطباعة يتحرك مع خروج الورق المطبوع
 * - الخزينة والمدفوعات: خروج العملة الذهبية وطوفانها من المحفظة
 * - الإعلانات: رنين بندولي مستمر للجرس مع تموجات صوتية مرئية
 * - الهدايا: اهتزاز مرح لصندوق الهدية مع تطاير نجوم التقدير
 * - الإدارة والإعدادات: دوران مسنن رئيسي مع مسنن فرعي متعاشق في الاتجاه المعاكس
 * - المخزون: هبوط واستقرار الصناديق المتراصة في تناغم لوجستي
 */
export function CreativeModuleIcon({
  module,
  isHovered,
  shouldReduceMotion,
}: {
  module: ApplicationModule;
  isHovered: boolean;
  shouldReduceMotion: boolean | null;
}) {
  const Icon = module.icon;
  const iconMotion = getIconHoverMotion(module.id, isHovered, shouldReduceMotion);

  return (
    <div
      style={{
        position: "relative",
        width: 32,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* الأيقونة الأساسية مع حركتها الفيزيائية المستمرة */}
      <motion.span
        animate={iconMotion}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={30} strokeWidth={2.3} />
      </motion.span>

      {/* العناصر التفاعلية الإبداعية الدقيقة (Bespoke Micro-stories) */}
      {isHovered && !shouldReduceMotion && (
        <>
          {/* نقطة البيع: سقوط منتج داخل سلة التسوق */}
          {module.id === "pos" && (
            <motion.span
              aria-hidden
              style={{
                position: "absolute",
                top: 2,
                left: 13,
                width: 8,
                height: 8,
                borderRadius: 2.5,
                background: "#ffffff",
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.35)",
                pointerEvents: "none",
                zIndex: 3,
              }}
              animate={{
                y: [-12, 4, 4, -12],
                scale: [0.6, 1, 0.9, 0],
                opacity: [0, 1, 1, 0],
                rotate: [0, 14, 0, 0],
              }}
              transition={{
                duration: 1.2,
                repeat: Infinity,
                times: [0, 0.45, 0.75, 1],
                ease: ["easeOut", "easeIn", "easeIn", "easeOut"],
              }}
            />
          )}

          {/* التوصيل: خطوط سرعة الطريق السريعة أسفل الشاحنة */}
          {module.id === "delivery" && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                bottom: 1,
                left: 2,
                right: 2,
                height: 2,
                overflow: "hidden",
                pointerEvents: "none",
              }}
            >
              <motion.div
                style={{
                  position: "absolute",
                  top: 0,
                  width: 10,
                  height: 2,
                  borderRadius: 1,
                  background: "#ffffff",
                }}
                animate={{ x: [26, -12], opacity: [0, 0.9, 0] }}
                transition={{ duration: 0.45, repeat: Infinity, ease: "linear" }}
              />
              <motion.div
                style={{
                  position: "absolute",
                  top: 0,
                  width: 6,
                  height: 2,
                  borderRadius: 1,
                  background: "#ffffff",
                }}
                animate={{ x: [26, -12], opacity: [0, 0.7, 0] }}
                transition={{ duration: 0.45, repeat: Infinity, ease: "linear", delay: 0.22 }}
              />
            </div>
          )}

          {/* قارئ الأسعار: شعاع ليزر ضوئي يمسح الباركود باستمرار */}
          {module.id === "priceChecker" && (
            <motion.div
              aria-hidden
              style={{
                position: "absolute",
                left: 3,
                right: 3,
                height: 2,
                borderRadius: 1,
                background: "#ffffff",
                boxShadow: "0 0 8px 1.5px #ffffff",
                pointerEvents: "none",
                zIndex: 3,
              }}
              animate={{
                top: [4, 25, 4],
                opacity: [0.5, 1, 0.5],
              }}
              transition={{
                duration: 1.25,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          )}

          {/* المطبعة والإنتاج: خروج الورق المطبوع من الطابعة */}
          {module.id === "workOrders" && (
            <motion.div
              aria-hidden
              style={{
                position: "absolute",
                top: 2,
                left: 10,
                width: 12,
                height: 8,
                borderRadius: 1.5,
                background: "#ffffff",
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
                pointerEvents: "none",
                zIndex: 3,
              }}
              animate={{
                y: [3, -5, -5, 3],
                opacity: [0, 1, 1, 0],
              }}
              transition={{
                duration: 1.4,
                repeat: Infinity,
                times: [0, 0.45, 0.75, 1],
                ease: "easeInOut",
              }}
            />
          )}

          {/* الخزينة والمدفوعات: عملة ذهبية تطفو من المحفظة */}
          {module.id === "treasury" && (
            <motion.div
              aria-hidden
              style={{
                position: "absolute",
                top: 4,
                left: 12,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#ffffff",
                boxShadow: "0 1px 4px rgba(0, 0, 0, 0.35)",
                pointerEvents: "none",
                zIndex: 3,
              }}
              animate={{
                y: [2, -9, -9, 2],
                scale: [0.6, 1.15, 1, 0.6],
                opacity: [0, 1, 0.9, 0],
                rotate: [0, 180, 360, 360],
              }}
              transition={{
                duration: 1.3,
                repeat: Infinity,
                times: [0, 0.45, 0.8, 1],
                ease: "easeInOut",
              }}
            />
          )}

          {/* إعلانات وتوجيهات الشركة: تموجات صوتية مرئية للجرس */}
          {module.id === "announcements" && (
            <>
              <motion.div
                aria-hidden
                style={{
                  position: "absolute",
                  top: 5,
                  right: 1,
                  width: 5,
                  height: 10,
                  borderRight: "2px solid #ffffff",
                  borderRadius: "0 6px 6px 0",
                  pointerEvents: "none",
                }}
                animate={{ opacity: [0, 0.9, 0], scale: [0.8, 1.25, 1.4] }}
                transition={{ duration: 0.85, repeat: Infinity, ease: "easeOut" }}
              />
              <motion.div
                aria-hidden
                style={{
                  position: "absolute",
                  top: 5,
                  left: 1,
                  width: 5,
                  height: 10,
                  borderLeft: "2px solid #ffffff",
                  borderRadius: "6px 0 0 6px",
                  pointerEvents: "none",
                }}
                animate={{ opacity: [0, 0.9, 0], scale: [0.8, 1.25, 1.4] }}
                transition={{ duration: 0.85, repeat: Infinity, ease: "easeOut", delay: 0.16 }}
              />
            </>
          )}

          {/* الهدايا والمجانيات: نجوم بهيجة تتطاير من الهدية */}
          {module.id === "gifts" && (
            <>
              <motion.div
                aria-hidden
                style={{
                  position: "absolute",
                  top: 2,
                  left: 7,
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "#ffffff",
                  boxShadow: "0 0 6px #ffffff",
                  pointerEvents: "none",
                  zIndex: 3,
                }}
                animate={{
                  y: [2, -7, -11],
                  x: [0, -3, -5],
                  opacity: [0, 1, 0],
                  scale: [0.5, 1.2, 0],
                }}
                transition={{ duration: 0.85, repeat: Infinity, ease: "easeOut" }}
              />
              <motion.div
                aria-hidden
                style={{
                  position: "absolute",
                  top: 2,
                  right: 7,
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "#ffffff",
                  boxShadow: "0 0 5px #ffffff",
                  pointerEvents: "none",
                  zIndex: 3,
                }}
                animate={{
                  y: [2, -6, -10],
                  x: [0, 3, 5],
                  opacity: [0, 1, 0],
                  scale: [0.5, 1.3, 0],
                }}
                transition={{ duration: 0.85, repeat: Infinity, ease: "easeOut", delay: 0.22 }}
              />
            </>
          )}

          {/* الإدارة والإعدادات: مسنن فرعي متعاشق يدور بالاتجاه المعاكس */}
          {module.id === "settings" && (
            <motion.div
              aria-hidden
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 10,
                height: 10,
                borderRadius: "50%",
                border: "2px dashed #ffffff",
                pointerEvents: "none",
                opacity: 0.85,
              }}
              animate={{ rotate: -360 }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
            />
          )}

          {/* المخزون والبضاعة: هبوط واستقرار صندوق فوق الصناديق */}
          {module.id === "inventory" && (
            <motion.div
              aria-hidden
              style={{
                position: "absolute",
                top: 1,
                left: 12,
                width: 8,
                height: 8,
                borderRadius: 2,
                background: "#ffffff",
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
                pointerEvents: "none",
                zIndex: 3,
              }}
              animate={{
                y: [-10, 2, 2, -10],
                scale: [0.7, 1, 0.95, 0.7],
                opacity: [0, 1, 1, 0],
              }}
              transition={{
                duration: 1.3,
                repeat: Infinity,
                times: [0, 0.45, 0.75, 1],
                ease: "easeInOut",
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
