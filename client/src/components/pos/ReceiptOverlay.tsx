// نافذة «تم الدفع بنجاح» بعد البيع (الإيصال على الشاشة + الطباعة ومحاكاة درج النقود).
// استُخرجت من client/src/pages/POS.tsx بلا تغيير سلوكيّ مع تحسين تجربة المستخدم والحركة المتزامنة.

import { useState, useEffect } from "react";
import { Printer, Check, Vault, Truck } from "lucide-react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { CopyButton } from "@/components/CopyButton";
import { openCashDrawer } from "@/lib/printing/print";
import { qrCodeDataUrl } from "@/lib/printing/qr";
import { STOREFRONT_URL } from "@/lib/printing/brand";
import { type Receipt, fmt, type PosColors as C } from "./posShared";
import { useModalFocus } from "./useModalFocus";
import { VirtualCashDrawer } from "./VirtualCashDrawer";

export interface GenericReceiptLine {
  name: string;
  qty: number | string;
  total: number;
}

export interface GenericReceipt {
  invoiceNumber?: string;
  num?: string;
  consignmentNumber?: string | null;
  delivery?: { partyName: string } | null;
  isCredit?: boolean;
  credit?: number;
  customerName?: string | null;
  lines: GenericReceiptLine[];
  total: number;
  received: number;
  change: number;
  method: string;
}

export interface GenericPosColors {
  primary: string;
  primaryFg: string;
  overlay?: string;
  amber?: string;
}

export interface ReceiptOverlayProps {
  C: GenericPosColors | C;
  receipt: GenericReceipt | Receipt;
  onDismiss: () => void;
  onPrint: () => void;
}

export function ReceiptOverlay({ C, receipt, onDismiss, onPrint }: ReceiptOverlayProps) {
  const modalRef = useModalFocus<HTMLDivElement>();
  const [drawerKicked, setDrawerKicked] = useState(true);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const invoiceNumber = (("invoiceNumber" in receipt ? receipt.invoiceNumber : undefined) ?? ("num" in receipt ? receipt.num : undefined) ?? "") as string;
  const consignmentNumber = ("consignmentNumber" in receipt ? receipt.consignmentNumber : undefined) ?? null;
  const delivery = "delivery" in receipt ? receipt.delivery : null;
  const isCredit = "isCredit" in receipt ? receipt.isCredit : false;
  const credit = "credit" in receipt ? receipt.credit : 0;
  const customerName = "customerName" in receipt ? receipt.customerName : null;

  // تشغيل تلقائي متزامن: فتح درج النقود وتوليد رمز QR للمتجر الإنتاجي الحقيقي
  useEffect(() => {
    void openCashDrawer();
    qrCodeDataUrl(STOREFRONT_URL, { size: 100, margin: 1 })
      .then(setQrSrc)
      .catch(() => undefined);
  }, []);

  const handleOpenDrawer = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      const res = await openCashDrawer();
      if (res.ok) {
        setDrawerKicked(true);
      }
    } catch {
      // ignore
    }
    setDrawerKicked((prev) => !prev);
  };

  const handlePrintAndDrawer = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPrint();
    void handleOpenDrawer();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onDismiss}
        style={{
          position: "fixed", inset: 0, zIndex: 100, background: C.overlay,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: "16px", backdropFilter: "blur(6px)", cursor: "pointer",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="تم الدفع بنجاح"
          style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            width: "100%", maxWidth: 440, cursor: "default", direction: "rtl",
          }}
        >
          {/* رأس الطابعة الحرارية المعدني (Printer Head Slot) */}
          <div
            style={{
              width: "100%",
              height: 38,
              background: "#1e293b",
              borderRadius: "14px 14px 0 0",
              border: "1.5px solid #334155",
              borderBottom: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 18px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
              zIndex: 10,
              position: "relative",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 700, color: "#94a3b8" }}>
              <motion.span
                animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1.15, 0.85] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: "#22c55e",
                  boxShadow: "0 0 10px #22c55e",
                  display: "inline-block",
                }}
              />
              <span>طابعة الإيصالات الحرارية</span>
            </div>
            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#64748b" }}>ESC/POS 80mm</span>
            {/* شق خروج الورقة في المنتصف */}
            <div
              style={{
                position: "absolute",
                bottom: -2,
                left: "50%",
                transform: "translateX(-50%)",
                width: "88%",
                height: 3,
                background: "#0f172a",
                borderRadius: 2,
              }}
            />
          </div>

          {/* الورقة الحرارية المطبوعة المنسابة من رأس الطابعة */}
          <motion.div
            initial={{ y: -90, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: "spring", damping: 18, stiffness: 120 }}
            style={{
              width: "100%",
              background: "#ffffff",
              color: "#1e293b",
              padding: "24px 28px 18px",
              boxShadow: "0 22px 50px rgba(0,0,0,0.35)",
              fontFamily: "system-ui, -apple-system, sans-serif",
              position: "relative",
              zIndex: 5,
            }}
          >
            {/* ختم مدفوع PAID ينطبع بحركة تفاعلية */}
            <motion.div
              initial={{ scale: 2, rotate: -15, opacity: 0 }}
              animate={{ scale: 1, rotate: -7, opacity: 0.92 }}
              transition={{ delay: 0.28, type: "spring", stiffness: 220, damping: 14 }}
              style={{
                position: "absolute",
                top: 22,
                left: 20,
                border: "2.5px solid #16a34a",
                color: "#16a34a",
                borderRadius: 8,
                padding: "2px 10px",
                fontSize: 12.5,
                fontWeight: 900,
                letterSpacing: "0.08em",
                display: "flex",
                alignItems: "center",
                gap: 4,
                pointerEvents: "none",
                background: "rgba(240, 253, 244, 0.9)",
              }}
            >
              <Check size={14} strokeWidth={3} />
              <span>مدفوع • PAID</span>
            </motion.div>

            {/* ترويسة الإيصال */}
            <div style={{ textAlign: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: "#0f172a" }}>الرؤية العربية</div>
              <div style={{ fontSize: 11, color: "#64748b" }}>إيصال مبيعات الكاشير المعتمد</div>
            </div>

            {/* رقم الفاتورة والوقت ورابط الطرد إن وجد */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 11,
                color: "#64748b",
                padding: "4px 0",
                borderBottom: "1px dashed #cbd5e1",
                marginBottom: 10,
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <span>فاتورة: {invoiceNumber}</span>
                <CopyButton value={invoiceNumber} title="نسخ رقم الفاتورة" successMessage="تم النسخ" />
                {consignmentNumber && (
                  <>
                    <span>·</span>
                    <Link href="/delivery?tab=transit" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#0284c7", fontWeight: 800 }} title="متابعة الطرد من إدارة التوصيل">
                      <Truck aria-hidden size={13} /> طرد {consignmentNumber}
                    </Link>
                  </>
                )}
              </span>
              <span style={{ direction: "ltr" }}>
                {new Date().toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>

            {/* م١ PR-B: بيعٌ بتوصيل — المتبقّي يُحصَّل عند التسليم مع المندوب (COD) */}
            {delivery && receipt.total > receipt.received && (
              <div style={{ background: "#f0f9ff", border: "1.5px solid #0284c7", borderRadius: 8, padding: "8px 12px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#0369a1", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Truck aria-hidden size={15} /> يُحصَّل عند التسليم ({delivery.partyName})
                </span>
                <span style={{ fontSize: 16, fontWeight: 900, color: "#0369a1", direction: "ltr" }}>
                  {fmt(receipt.total - receipt.received)} <span style={{ fontSize: 10 }}>د.ع</span>
                </span>
              </div>
            )}

            {/* آجل على العميل إن وجد */}
            {isCredit && (credit ?? 0) > 0 && (
              <div style={{ background: "#fffbeb", border: "1.5px solid #d97706", borderRadius: 8, padding: "8px 12px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#b45309" }}>آجل على {customerName ?? "العميل"}</span>
                <span style={{ fontSize: 16, fontWeight: 900, color: "#b45309", direction: "ltr" }}>
                  {fmt(credit ?? 0)} <span style={{ fontSize: 10 }}>د.ع</span>
                </span>
              </div>
            )}

            {/* تفاصيل السلع المشتراة */}
            <div style={{ marginBottom: 12, fontSize: 12 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr 1fr",
                  color: "#64748b",
                  fontSize: 10.5,
                  fontWeight: 700,
                  paddingBottom: 4,
                  borderBottom: "1px solid #e2e8f0",
                }}
              >
                <span>الصنف</span>
                <span style={{ textAlign: "center" }}>الكمية</span>
                <span style={{ textAlign: "left" }}>الإجمالي</span>
              </div>
              <div style={{ maxHeight: 110, overflowY: "auto", margin: "4px 0" }}>
                {receipt.lines.map((ln, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "2fr 1fr 1fr",
                      padding: "4px 0",
                      borderBottom: "1px dotted #f1f5f9",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ln.name}
                    </span>
                    <span style={{ textAlign: "center", color: "#64748b", direction: "ltr" }}>{ln.qty}</span>
                    <span style={{ textAlign: "left", fontWeight: 700, direction: "ltr" }}>{fmt(ln.total)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* الملخص المالي للفاتورة */}
            <div style={{ borderTop: "1.5px dashed #94a3b8", paddingTop: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>إجمالي الفاتورة:</span>
                <span style={{ fontSize: 20, fontWeight: 900, color: "#0f172a", direction: "ltr" }}>
                  {fmt(receipt.total)} <span style={{ fontSize: 12, fontWeight: 700 }}>د.ع</span>
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, color: "#475569" }}>
                <span>المبلغ المدفوع ({receipt.method}):</span>
                <span style={{ fontWeight: 700, direction: "ltr" }}>{fmt(receipt.received)} د.ع</span>
              </div>
              {receipt.change > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#16a34a", fontWeight: 700, marginTop: 3 }}>
                  <span>الباقي للعميل:</span>
                  <span style={{ fontSize: 14, fontWeight: 900, direction: "ltr" }}>{fmt(receipt.change)} د.ع</span>
                </div>
              )}
            </div>

            {/* إعلان المتجر الإلكتروني ورمز QR للتصفح والشراء */}
            <div
              style={{
                marginTop: 8,
                padding: "8px 10px",
                border: "1.5px dashed #94a3b8",
                borderRadius: 8,
                background: "#f8fafc",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#0f172a" }}>تسوق عبر متجرنا الإلكتروني</div>
                <div style={{ fontSize: 9.5, fontWeight: 900, color: "#0284c7", direction: "ltr", textAlign: "right", marginTop: 1 }}>
                  alarabiya.online/store
                </div>
                <div style={{ fontSize: 9, color: "#64748b", marginTop: 2 }}>امسح الرمز للتصفح والطلب المباشر</div>
                <div style={{ fontSize: 8.5, color: "#0284c7", fontWeight: 700, marginTop: 2 }}>
                  تطبيقنا قريباً على Google Play & App Store
                </div>
              </div>
              {qrSrc && (
                <img
                  src={qrSrc}
                  alt="QR المتجر"
                  style={{ width: 50, height: 50, borderRadius: 4, border: "1px solid #cbd5e1" }}
                />
              )}
            </div>

            {/* الحافة السفلية المسننة (Sawtooth Tear-off Edge) */}
            <div
              style={{
                position: "absolute",
                bottom: -8,
                left: 0,
                right: 0,
                height: 8,
                background: "repeating-linear-gradient(45deg, #ffffff, #ffffff 5px, transparent 5px, transparent 10px)",
              }}
            />
          </motion.div>

          {/* محاكاة فتح درج النقود التفاعلية المتزامنة */}
          <VirtualCashDrawer
            isOpen={drawerKicked}
            onToggle={() => setDrawerKicked((prev) => !prev)}
          />

          {/* أزرار الإجراءات الفورية أسفل الفاتورة */}
          <div style={{ width: "100%", marginTop: 12, display: "flex", gap: 8, zIndex: 10 }}>
            <button
              onClick={handlePrintAndDrawer}
              style={{
                flex: 1.2, height: 44, background: "#1e293b", border: "1.5px solid #475569",
                borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 800,
                cursor: "pointer", color: "#ffffff", display: "flex", alignItems: "center",
                justifyContent: "center", gap: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
              }}
            >
              <Printer size={16} aria-hidden />
              <span>طباعة وفتح الدرج</span>
            </button>

            <button
              onClick={handleOpenDrawer}
              title="فتح درج النقود يدوياً (F10)"
              style={{
                flex: 0.9, height: 44, background: drawerKicked ? "#15803d" : "#334155",
                border: "1.5px solid #475569", borderRadius: 8, fontFamily: "inherit",
                fontSize: 13, fontWeight: 700, cursor: "pointer", color: "#ffffff",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                transition: "background 0.2s",
              }}
            >
              {drawerKicked ? <Check size={16} aria-hidden /> : <Vault size={16} aria-hidden />}
              <span>{drawerKicked ? "انفتح الدرج" : "فتح الدرج"}</span>
            </button>

            <button
              onClick={onDismiss}
              style={{
                flex: 1, height: 44, background: C.primary, border: "none", borderRadius: 8,
                fontFamily: "inherit", fontSize: 13, fontWeight: 800, cursor: "pointer",
                color: C.primaryFg, boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
              }}
            >
              فاتورة جديدة
            </button>
          </div>

          <div style={{ marginTop: 10, fontSize: 11.5, color: "#94a3b8" }}>
            اضغط في أي مكان أو اختر إجراء للمتابعة
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
