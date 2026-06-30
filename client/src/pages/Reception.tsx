import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowLeftRight,
  Banknote,
  Camera,
  Check,
  CreditCard,
  FileText,
  Image as ImageIcon,
  Layers,
  MessageCircle,
  Minus,
  Music,
  Package,
  Palette,
  Pencil,
  Phone,
  Plus,
  Printer,
  Ruler,
  Search,
  ShoppingCart,
  Store,
  Trash2,
  Truck,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SmartCustomerInput, type SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { CustomizationDialog, type CustomizationData, composeCustomizationText, emptyCustomization } from "@/components/CustomizationDialog";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { parseScan } from "@/lib/scanRouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { CashCounter } from "@/components/CashCounter";
import { printShiftClose, printShiftOpen } from "@/lib/printing/print";

/**
 * شاشة الاستقبال — نقطة بيع هجينة لخدمة العملاء.
 *
 * الجاهز يُباع فوراً (فاتورة POS عبر saleRouter)، والمخصّص يدخل طابور المطبعة (workOrders.create
 * أمر مستقلّ لكل صنف). ربط بـcatalog.posList/byBarcode للبحث والمسح، وعرض هجين للإجماليّات.
 *
 * مسار: /work-orders/reception. الدور: cashier فأعلى. يلزم وردية مفتوحة (saleRouter).
 *
 * شريحة customer-service-reception (٢٣/٦/٢٦) — README §5.1.
 */

type PosRow = NonNullable<RouterOutputs["catalog"]["posList"]>[number];
type NumMode = "QTY" | "DISC" | "PAY";
type PayMethod = "CASH" | "CARD" | "TRANSFER";

type CartLine = {
  key: string; // معرّف فريد للسطر (للأصناف المخصّصة المتعدّدة من نفس المنتج)
  row: PosRow;
  qty: number;
  origPrice?: number;
  disc?: number; // نسبة خصم
  custom?: CustomizationData; // إن كان مخصّصاً
};

// مبالغ سريعة بالقيمة الفعلية (د.ع). إصلاح P2 (٢٣/٦/٢٦): كان `setQuickAmt(v * 1000)` يجعل
// زرّ «5,000» يُدخل 5,000,000 ⇒ فكّةٌ خاطئة ١٠٠٠× — كارثة كاشير.
const QUICK_AMTS = [1000, 5000, 10000, 25000];

function effectivePrice(line: CartLine): number {
  const base = line.origPrice ?? Number(line.row.price ?? 0);
  if (line.disc && line.disc > 0) return base * (1 - line.disc / 100);
  return base;
}
function lineTotal(line: CartLine): number {
  return effectivePrice(line) * line.qty;
}
function isCustomKind(line: CartLine): boolean {
  return !!line.custom;
}
/** الإجمالي الكامل لسطر مخصّص (سعر السطر + تكلفة التوصيل). يُستعمل لـsalePrice على workOrder
 *  ليطابق إجمالي الفاتورة عند التسليم (deliverWorkOrder يَحسبه من wo.salePrice وحده). */
function customLineGrand(line: CartLine): number {
  if (!line.custom) return lineTotal(line);
  const delivery = line.custom.hasDelivery ? Number(line.custom.deliveryCost || 0) : 0;
  return lineTotal(line) + delivery;
}

/** حالة المخزون للأصناف الجاهزة (المخصَّصة لا مَخزون لها — إنتاج). يَحسب الطلب الكلّي للصنف
 *  عبر كل وحداته في السلّة (رصيد الفرع مُشترك بين القطعة/الدرزن/الكرتون). نَمط مُطابق POS.tsx. */
function buildStockState(cart: CartLine[]) {
  const demandByVariant = new Map<number, number>();
  for (const l of cart) {
    if (l.custom) continue;
    const f = Number(l.row.conversionFactor) || 1;
    demandByVariant.set(l.row.variantId, (demandByVariant.get(l.row.variantId) ?? 0) + l.qty * f);
  }
  return (line: CartLine) => {
    if (line.custom || line.row.isService) {
      return { isOut: false, isShort: false, availInUnit: Number.POSITIVE_INFINITY };
    }
    const convFactor = Number(line.row.conversionFactor) || 1;
    const availBase = line.row.stockBase ?? 0;
    const reqBase = demandByVariant.get(line.row.variantId) ?? line.qty * convFactor;
    const isOut = availBase <= 0;
    const isShort = !isOut && reqBase > availBase;
    const availInUnit = Math.floor(availBase / convFactor);
    return { isOut, isShort, availInUnit };
  };
}

export default function Reception() {
  const me = trpc.auth.me.useQuery();
  const branchId = useMemo(() => Number(me.data?.branchId ?? 1), [me.data?.branchId]);
  const utils = trpc.useUtils();

  // وردية خدمة الزبائن (RECEPTION): درج/رصيد افتتاحي/عرابين مستقلّة عن كاشير التجزئة (RETAIL).
  const branchesQ = trpc.branches.list.useQuery();
  const shiftQ = trpc.shifts.current.useQuery({ branchId, shiftType: "RECEPTION" });
  const shift = shiftQ.data ?? null;
  const [opening, setOpening] = useState("0");
  const [openCounts, setOpenCounts] = useState<Record<number, number>>({});
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState("");
  const [closeCounts, setCloseCounts] = useState<Record<number, number>>({});
  const branchName = useMemo(
    () => (branchesQ.data ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
    [branchesQ.data, branchId],
  );

  const openShiftM = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await shiftQ.refetch();
      void printShiftOpen({
        shiftId: res.shiftId,
        openingBalance: Number(opening || 0),
        cashierName: me.data?.name ?? "موظف الخدمة",
        branchName,
        openedAt: new Date(),
      });
    },
    onError: (e) => notify.err(e),
  });

  // تقرير الوردية (Z) — يُحمَّل فقط عند فتح نافذة الإغلاق.
  const reportQ = trpc.shifts.report.useQuery({ shiftId: shift?.id ?? 0 }, { enabled: closing && !!shift });

  const closeShiftM = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const rep = reportQ.data;
      void printShiftClose({
        shiftId: r.shiftId,
        openedAt: shift?.openedAt ?? null,
        closedAt: new Date(),
        cashierName: me.data?.name ?? "موظف الخدمة",
        branchName,
        openingBalance: r.openingBalance,
        invoiceCount: rep?.invoiceCount ?? 0,
        salesTotal: rep?.salesTotal ?? "0",
        payments: (rep?.payments ?? []).map((p) => ({
          method: p.method,
          direction: p.direction as "IN" | "OUT",
          count: Number(p.count),
          total: p.total,
        })),
        expectedCash: r.expectedCash,
        countedCash: r.countedCash,
        variance: r.variance,
      });
      setClosing(false);
      setCounted("");
      setCloseCounts({});
      await utils.shifts.current.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  // ───── الحالة ─────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  const [numMode, setNumMode] = useState<NumMode>("PAY");
  const [payInput, setPayInput] = useState("");
  const [method, setMethod] = useState<PayMethod>("CASH");
  const [paymentReference, setPaymentReference] = useState(""); // P2 fix: مرجع البطاقة للعرابين
  const [showInbox, setShowInbox] = useState(false);
  const [showCustomization, setShowCustomization] = useState<{ row: PosRow; editingKey?: string } | null>(null);
  const [customer, setCustomer] = useState<SmartCustomerValue>({ customerId: null, name: "", phone: null, isNew: false });
  const [channel, setChannel] = useState<"WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE">("WALK_IN");
  const [channelHandle, setChannelHandle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // idempotency: مفتاح واحد لكل دورة إرسال — يتجدّد بعد النجاح.
  const reqIdRef = useRef<string>(crypto.randomUUID());
  const searchRef = useRef<HTMLInputElement>(null);

  // ───── حسابات هجينة ───────────────────────────────────────────────────────
  const cartCount = cart.reduce((s, c) => s + c.qty, 0);
  const sumDirectD = cart.filter((c) => !isCustomKind(c)).reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const sumCustomD = cart.filter((c) => isCustomKind(c)).reduce((s, c) => s.plus(D(customLineGrand(c))), D(0));
  const grandTotalD = sumDirectD.plus(sumCustomD);
  const grandTotal = round2(grandTotalD).toNumber();
  const sumDirect = round2(sumDirectD).toNumber();
  const sumCustom = round2(sumCustomD).toNumber();

  // العربون الإجمالي من نوافذ التخصيص.
  const totalDepositsD = cart
    .filter(isCustomKind)
    .reduce((s, c) => s.plus(D(c.custom?.deposit || 0)), D(0));
  // المبلغ المتوقّع دفعه فوراً = بيع مباشر (كامل) + عربون المخصّص.
  const expectedNowD = sumDirectD.plus(totalDepositsD);
  const expectedNow = round2(expectedNowD).toNumber();

  // ما أدخله الكاشير في لوحة الأرقام (مع تكيّف Quick Pay).
  const paidD = D(payInput || 0);
  const paid = round2(paidD).toNumber();
  const changeD = paidD.minus(expectedNowD);
  const change = round2(changeD).toNumber();
  const remainingD = expectedNowD.minus(paidD);
  const remaining = round2(remainingD).toNumber();
  const isChange = paidD.gt(0) && paidD.gte(expectedNowD);
  const isOwing = paidD.gt(0) && paidD.lt(expectedNowD);

  const hasCustom = cart.some(isCustomKind);
  // TRANSFER غير مدعوم على workOrders (schema: CASH/CARD فقط). إصلاح P2: نعطّل التحويل عند وجود
  // مخصّص بدل تحويله صامتاً لـCASH (كان يشوّه نوع الدفع المُسجَّل).
  const transferDisabled = hasCustom;
  const needPaymentRef = hasCustom && method === "CARD";

  // ───── البحث ──────────────────────────────────────────────────────────────
  const debounced = useDebouncedValue(search, 180);
  const searchResults = trpc.catalog.posList.useQuery(
    { branchId, tier: "RETAIL", query: debounced, limit: 15, includeReceptionServices: true },
    { enabled: debounced.trim().length >= 2, placeholderData: keepPreviousData, staleTime: 15_000 },
  );
  const results = searchResults.data ?? [];
  const resultsEmpty = results.length === 0 && debounced.trim().length >= 2 && !searchResults.isFetching;

  // ───── السلّة ─────────────────────────────────────────────────────────────
  const addRow = useCallback((row: PosRow) => {
    // إصلاح P2 (٢٣/٦/٢٦): حارس السعر **قبل** فتح نافذة التخصيص — كان يَسمح لمخصَّصٍ بلا سعر RETAIL
    // بالدخول للسلّة ثم يَفشل عند الإرسال (createWorkOrder يَرفض salePrice<=0) بَعد ما اَلتزَمت
    // فاتورة البيع — رحلةٌ بِنصف نتيجة. الحارس موحَّد للنوعين.
    if (row.price == null || Number(row.price) <= 0) {
      notify.err(`لا سعر RETAIL لـ ${row.productName} (${row.unitName}) — حدّد سعراً من /products أوّلاً`);
      return;
    }
    // المنتج المخصّص (products.isCustomizable=true) ⇒ افتح نافذة التخصيص.
    if (row.isCustomizable) {
      setShowCustomization({ row });
      setSearch("");
      setShowDrop(false);
      return;
    }
    setCart((prev) => {
      // دمج كميّات الصنف الجاهز المُكرَّر (لا تكرار سطر).
      const i = prev.findIndex((c) => !isCustomKind(c) && c.row.productUnitId === row.productUnitId);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        setSelKey(next[i].key);
        return next;
      }
      const key = `d-${row.productUnitId}-${Date.now()}`;
      setSelKey(key);
      return [...prev, { key, row, qty: 1 }];
    });
    setSearch("");
    setShowDrop(false);
    searchRef.current?.focus();
  }, []);

  function saveCustomization(data: CustomizationData) {
    if (!showCustomization) return;
    const { row, editingKey } = showCustomization;
    if (editingKey) {
      setCart((prev) => prev.map((c) => (c.key === editingKey ? { ...c, custom: data, qty: 1 } : c)));
    } else {
      const key = `c-${row.productUnitId}-${Date.now()}`;
      setCart((prev) => [...prev, { key, row, qty: 1, custom: data }]);
      setSelKey(key);
    }
    setShowCustomization(null);
    searchRef.current?.focus();
  }

  function changeQty(key: string, delta: number) {
    setCart((prev) =>
      prev.map((c) => (c.key === key ? { ...c, qty: Math.max(1, c.qty + delta) } : c)),
    );
  }
  function removeRow(key: string) {
    setCart((prev) => prev.filter((c) => c.key !== key));
    if (selKey === key) setSelKey(null);
  }
  async function clearCart() {
    if (cart.length === 0) return;
    if (!(await confirm({
      variant: "warning",
      title: "تفريغ السلّة",
      description: "سيُمسح كلّ ما في الطلب الحالي. متابعة؟",
      confirmText: "تفريغ",
    }))) return;
    setCart([]);
    setSelKey(null);
    setPayInput("");
  }

  // ───── الباركود ───────────────────────────────────────────────────────────
  const lookupBarcode = useCallback(
    async (code: string) => {
      try {
        const row = await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier: "RETAIL" });
        if (!row) notify.err(`باركود غير معروف: ${code}`);
        else addRow(row);
      } catch (e: unknown) {
        notify.err(e, "خطأ في المسح");
      }
    },
    [branchId, addRow, utils],
  );
  const handleHidScan = useCallback(
    async (raw: string) => {
      const r = parseScan(raw);
      if (r.type === "product") {
        await lookupBarcode(r.barcode);
        setSearch("");
      } else if (r.type === "customer") {
        setCustomer({ customerId: r.id, name: `عميل #${r.id}`, phone: null, isNew: false });
        notify.ok(`تم تحديد العميل #${r.id}`);
      }
    },
    [lookupBarcode],
  );
  useBarcodeScanner(handleHidScan, { enabled: !showCustomization && !submitting });

  // ───── لوحة الأرقام ──────────────────────────────────────────────────────
  function numPress(k: string) {
    if (numMode === "QTY" && selKey) {
      const line = cart.find((c) => c.key === selKey);
      if (!line) return;
      setCart((prev) =>
        prev.map((c) => {
          if (c.key !== selKey) return c;
          let s = String(c.qty);
          if (k === "DEL") s = s.length > 1 ? s.slice(0, -1) : "1";
          else if (k === "C") s = "1";
          else s = s === "0" ? k : s + k;
          return { ...c, qty: Math.max(1, parseInt(s, 10) || 1) };
        }),
      );
    } else if (numMode === "DISC" && selKey) {
      const line = cart.find((c) => c.key === selKey);
      if (!line || isCustomKind(line)) return;
      setCart((prev) =>
        prev.map((c) => {
          if (c.key !== selKey) return c;
          const base = c.origPrice ?? Number(c.row.price ?? 0);
          let s = c.disc != null ? String(c.disc) : "";
          if (k === "DEL") s = s.slice(0, -1);
          else if (k === "C") s = "";
          else if (k === "." && s.includes(".")) return c;
          else s = s + k;
          const disc = Math.min(100, Math.max(0, parseFloat(s) || 0));
          return { ...c, origPrice: base, disc };
        }),
      );
    } else {
      setPayInput((prev) => {
        if (k === "DEL") return prev.slice(0, -1);
        if (k === "C") return "";
        if (k === "." && prev.includes(".")) return prev;
        return prev + k;
      });
    }
  }
  function setQuickAmt(v: number) {
    setNumMode("PAY");
    setPayInput(String(v));
  }
  function payAll() {
    setNumMode("PAY");
    setPayInput(String(expectedNow));
  }

  // ───── إنشاء العميل عند الحاجة (ensureCustomerId) ────────────────────────
  // إصلاح P2 (٢٣/٦/٢٦): قبل الإصلاح كان customer.customerId=null يُسقط الاسم/الهاتف ⇒ فاتورة وأمر
  // شغل بلا عميل (تَسليم آجل لاحقاً يَفشل بـ«طلب الخدمة الآجل يتطلب عميلاً محدداً»).
  const createCustomerM = trpc.customers.create.useMutation();
  async function ensureCustomerId(): Promise<number | null> {
    if (customer.customerId) return customer.customerId;
    if (!customer.name?.trim()) return null;
    if (!(await confirm({
      variant: "warning",
      title: "إنشاء عميل جديد",
      description: `سيُنشأ عميل جديد باسم «${customer.name.trim()}». متابعة؟`,
      confirmText: "إنشاء العميل",
    }))) {
      throw new Error("ألغى المستخدم إنشاء العميل");
    }
    const created = await createCustomerM.mutateAsync({
      name: customer.name.trim(),
      phone: customer.phone || null,
      customerType: "فرد",
      defaultPriceTier: "RETAIL",
    });
    // عَقد الراوتر يُرجع {id, customerId} كلاهما (للتوافق). نَحرس ضدّ NaN لو تَغيّر العقد.
    const id = Number((created as any).id ?? (created as any).customerId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("تعذّر قراءة مُعرّف العميل الجديد من الخادم");
    }
    // عكس الاختيار في الواجهة بعد الإنشاء.
    setCustomer({ customerId: id, name: customer.name.trim(), phone: customer.phone ?? null, isNew: false });
    return id;
  }

  // ───── الإرسال (هجين) ─────────────────────────────────────────────────────
  const saleM = trpc.sales.create.useMutation();
  const woM = trpc.workOrders.create.useMutation();
  // خدمات الطباعة المُوجَّهة للاستقبال تُباع عبر مسار createPrintSale المدقَّق (خصم مواد + COGS).
  const printSaleM = trpc.printPos.createSale.useMutation();

  async function handleSubmit(opts: { quickFullPay: boolean }) {
    if (cart.length === 0) return;
    if (!shift) {
      notify.err("لا توجد وردية خدمة زبائن مفتوحة — افتح الوردية أولاً");
      return;
    }
    // P2: مرجع البطاقة إلزاميّ عند وجود مخصَّص (createWorkOrder يَرفض CARD بلا مرجع).
    if (hasCustom && method === "CARD" && !paymentReference.trim()) {
      notify.err("رقم العملية المرجعي مطلوب عند الدفع ببطاقة لطلبات الخدمة المخصّصة");
      return;
    }
    // P2: التحويل غير مدعوم في workOrders (CASH/CARD فقط) ⇒ لا نقبله مع وجود مخصّصات.
    if (hasCustom && method === "TRANSFER") {
      notify.err("التحويل البنكي غير مدعوم لعرابين أوامر الشغل — اختر نقداً أو بطاقة");
      return;
    }

    const directLines = cart.filter((c) => !isCustomKind(c));
    // فصل خدمات الطباعة (تُباع عبر createPrintSale) عن البيع العادي (sales.create).
    const regularLines = directLines.filter((c) => !c.row.isPrintService);
    const printLines = directLines.filter((c) => c.row.isPrintService);
    const customItems = cart.filter(isCustomKind);

    // عربون كل صنف مخصّص: Quick = كامل سعر الصنف+التوصيل؛ غير ذلك = ما حفظه في النافذة.
    // إصلاح P1: salePrice على workOrder = lineTotal + deliveryCost. deliverWorkOrder يَحسب
    // إجمالي الفاتورة من wo.salePrice وحده ويَرفض deposit > salePrice ⇒ إن استَبعَدنا التوصيل
    // فأمر التسليم المدفوع كاملاً يَفشل، وإن لم يَفشل فالتوصيل بلا إيراد فعلاً.
    const customWithDeposits = customItems.map((c) => {
      const full = D(customLineGrand(c));
      const deposit = opts.quickFullPay ? full.toFixed(2) : (c.custom?.deposit || "0");
      return { c, depositStr: deposit, salePriceStr: full.toFixed(2) };
    });

    // الدفع المتوقّع لهذا التنفيذ.
    const expectedDepositsD = customWithDeposits.reduce((s, x) => s.plus(D(x.depositStr)), D(0));
    const expectedTotalD = round2(sumDirectD.plus(expectedDepositsD));
    const inputPaidD = opts.quickFullPay ? expectedTotalD : paidD;

    // إصلاح P1 (٢٣/٦/٢٦): الفحص السابق كان يَتحقّق من تَغطية البيع المباشر فقط، بَينما يَرسل
    // العربون الكامل لكل صنف لـcreateWorkOrder الذي يَقيّده receipt(IN)+PAYMENT_IN فوراً.
    // النتيجة: نَقد غير مَقبوض فعلاً يَدخل الدفتر ⇒ تَسوية صندوق/AR مشوَّهة. الفحص الآن
    // يَستلزم تَغطية إجمالي العَرابين أيضاً (المُدخَل ≥ المتوقَّع).
    if (!opts.quickFullPay && inputPaidD.lt(expectedTotalD)) {
      notify.err(`المبلغ المُدخَل (${fmt(inputPaidD.toFixed(2))}) أقلّ من المتوقَّع (${fmt(expectedTotalD.toFixed(2))} = بيع + عرابين). عدّل العرابين من النوافذ أو أكمِل المبلغ.`);
      return;
    }

    // تَفعيل قَفل الإرسال **قبل** ensureCustomerId لمنع سباق نَقر مَزدوج يُنشئ عميلاً مكرَّراً
    // (ensureCustomerId يَحتوي عميلية confirm() غير متزامنة).
    if (submitting) return;
    setSubmitting(true);

    let customerId: number | null = null;
    try {
      customerId = await ensureCustomerId();
    } catch (e: any) {
      setSubmitting(false);
      notify.err(e?.message || "تعذّر تجهيز العميل");
      return;
    }

    try {
      let invoiceId: number | null = null;
      const createdWoIds: number[] = [];

      // ١) فاتورة البيع المباشر للأصناف العادية (إن وُجدت).
      if (regularLines.length > 0) {
        const lines = regularLines.map((c) => {
          const base: any = {
            variantId: c.row.variantId,
            productUnitId: c.row.productUnitId,
            quantity: String(c.qty),
          };
          if (c.disc != null && c.disc > 0) base.discountPercent = String(c.disc);
          return base;
        });
        const saleAmount = round2(regularLines.reduce((s, c) => s.plus(D(lineTotal(c))), D(0))).toFixed(2);
        const res = await saleM.mutateAsync({
          branchId,
          shiftId: shift.id,
          sourceType: "POS",
          customerId: customerId ?? undefined,
          lines,
          payment: { amount: saleAmount, method },
          clientRequestId: `${reqIdRef.current}-sale`,
        });
        invoiceId = res.invoiceId ?? null;
      }

      // ١.ب) فاتورة خدمات الطباعة (الاستقبال): createPrintSale يَخصم وصفة المواد ويُسجّل COGS
      //       (sales.create لا يَفعل ذلك). السعر اليدوي = السعر الفعّال المعروض في السلّة (بعد الخصم).
      if (printLines.length > 0) {
        const lines = printLines.map((c) => ({
          variantId: c.row.variantId,
          productUnitId: c.row.productUnitId,
          quantity: String(c.qty),
          unitPriceOverride: round2(D(effectivePrice(c))).toFixed(2),
        }));
        const printAmount = round2(printLines.reduce((s, c) => s.plus(D(lineTotal(c))), D(0))).toFixed(2);
        const res = await printSaleM.mutateAsync({
          branchId,
          shiftId: shift.id,
          customerId: customerId ?? undefined,
          lines,
          payment: { amount: printAmount, method },
          clientRequestId: `${reqIdRef.current}-print`,
        });
        if (invoiceId == null) invoiceId = (res as { invoiceId?: number }).invoiceId ?? null;
      }

      // ٢) أمر شغل لكل صنف مخصّص.
      for (const x of customWithDeposits) {
        const c = x.c;
        const custom = c.custom!;
        const finalText = composeCustomizationText(custom);
        // إصلاح P1 (٢٣/٦/٢٦): المنتجات المخصّصة ذات المخزون كانت تَخرج بلا materials ⇒ المخزون
        // لا يَنخفض و COGS صفر، وعند التسليم الفاتورة تُنشَأ بسطر للمنتج الأساس بدون خصم سابق
        // ⇒ بيعٌ بلا تكلفة، أرباح مُبالَغة، رصيدٌ مُبالَغ في المخزون.
        // الحل: لو المنتج Service (بلا مخزون) ⇒ لا مواد. غير ذلك ⇒ المنتج الأساس يَستهلك
        // baseQuantity = qty * conversionFactor (يُقرَّب لعدد صحيح لمطابقة فحص createWorkOrder).
        const materials: { variantId: number; baseQuantity: number }[] = [];
        if (!c.row.isService) {
          const factor = Number(c.row.conversionFactor) || 1;
          const baseQty = Math.max(1, Math.round(c.qty * factor));
          materials.push({ variantId: c.row.variantId, baseQuantity: baseQty });
        }
        const res = await woM.mutateAsync({
          branchId,
          customerId: customerId ?? undefined,
          baseVariantId: c.row.variantId,
          title: custom.title.trim() || c.row.productName,
          customizationText: finalText || null,
          quantity: c.qty,
          materials,
          laborCost: "0",
          // ملاحظة: salePrice الآن يَضمّ التوصيل (إصلاح P1 — حتى يَتطابق مع deliverWorkOrder).
          salePrice: x.salePriceStr,
          dueDate: custom.dueDate || null,
          priority: custom.priority,
          deposit: x.depositStr,
          paymentMethod: method === "TRANSFER" ? "CASH" : method,
          paymentReference: needPaymentRef ? paymentReference.trim() : null,
          receptionChannel: channel,
          channelHandle: channelHandle || null,
          hasDelivery: custom.hasDelivery,
          deliveryAddress: custom.deliveryAddress || null,
          // deliveryCost يَبقى في عمود مستقلّ للتقرير؛ salePrice الإجماليّ ضمّه فعلاً.
          deliveryCost: custom.hasDelivery ? D(custom.deliveryCost || 0).toFixed(2) : "0",
          designImages: custom.designImages.map((img, idx) => ({
            url: img.dataUrl,
            caption: img.name ?? null,
            sortOrder: idx,
          })),
          clientRequestId: `${reqIdRef.current}-wo-${c.key}`,
        });
        const woId = (res as { workOrderId?: number }).workOrderId;
        if (woId) createdWoIds.push(woId);
      }

      // إفراغ + إشعار + تجديد idempotency key (نَجاح كامل فقط).
      const summary = [
        invoiceId ? `فاتورة #${invoiceId}` : null,
        createdWoIds.length > 0 ? `${createdWoIds.length} أمر شغل` : null,
      ]
        .filter(Boolean)
        .join(" + ");
      notify.ok(`تمّ ${summary}`);
      setCart([]);
      setSelKey(null);
      setPayInput("");
      setPaymentReference("");
      reqIdRef.current = crypto.randomUUID();
      // تحديث القوائم.
      utils.workOrders.list.invalidate().catch(() => {});
      utils.shifts.current.invalidate().catch(() => {});
    } catch (e: unknown) {
      // ذرّية جزئية: الفاتورة قد تَكون التُزِمت قبل فَشل أوامر الشغل (أو العكس). نُبقي reqIdRef
      // ثابتاً (لا نُجدّده) — sales.create و workOrders.create يَستعملان clientRequestId فريداً
      // (`-sale` و`-wo-${key}`) ⇒ إعادة الضغط على نفس الزرّ تُكمل ما نَقص بأمان (idempotency
      // على الخادم تُجنّب التَكرار) ولا تُنشئ سَلَّةً مَلتزَمة مرّتَين.
      notify.err(e, "تعذّر إتمام الاستلام بالكامل — اضغط مرّة أخرى لاستئناف ما لم يَلتَزم (idempotent)");
    } finally {
      setSubmitting(false);
    }
  }

  // إصلاح P2 (٢٣/٦/٢٦): F4 كان يُمسك إغلاقاً بياناتيّاً قديماً (payInput/method/customer/shift)
  // لأن الاعتماديّات لم تَشملها ⇒ نقرة F4 بعد تعديل المبلغ تَنفّذ بمبلغ قديم. الحل: ref يَحمل
  // أحدث `handleSubmit` ⇒ المُستَمع يَستدعي ref.current دائماً.
  const submitRef = useRef<(opts: { quickFullPay: boolean }) => void>(() => {});
  useEffect(() => {
    submitRef.current = handleSubmit;
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showCustomization) return;
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "F4") {
        e.preventDefault();
        submitRef.current?.({ quickFullPay: false });
      } else if (e.key === "Escape") {
        if (showInbox) setShowInbox(false);
        else if (showDrop) setShowDrop(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showInbox, showDrop, showCustomization]);

  // اقتراح الكاشير: لا يبني الواجهة قبل توفّر الفرع.
  if (me.isLoading || shiftQ.isLoading) {
    return <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>;
  }

  // بوّابة وردية خدمة الزبائن: لا عمل بلا وردية RECEPTION مفتوحة (درج/رصيد افتتاحي مستقلّ).
  if (!shift) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-4" dir="rtl">
        <div className="w-full max-w-md rounded-2xl border bg-card p-7 shadow-lg">
          <div className="mb-1 flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-lg bg-violet-100 text-violet-700">
              <Palette aria-hidden className="size-5" />
            </span>
            <h2 className="text-xl font-extrabold">افتح وردية خدمة الزبائن</h2>
          </div>
          <p className="mb-5 text-sm text-muted-foreground">
            درجٌ ورصيدٌ افتتاحيٌّ مستقلّ لاستلام الطلبات وقبض العرابين. لا يمكن العمل بدون وردية مفتوحة.
          </p>
          <label className="mb-1.5 block text-sm font-bold">الرصيد الافتتاحي للصندوق (د.ع)</label>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
            className="mb-3 h-12 text-end text-lg font-extrabold tabular-nums"
          />
          <div className="mb-4">
            <CashCounter
              value={openCounts}
              onChange={(counts, total) => {
                setOpenCounts(counts);
                setOpening(total);
              }}
            />
          </div>
          <Button
            className="h-12 w-full text-base font-bold"
            disabled={openShiftM.isPending}
            onClick={() => openShiftM.mutate({ branchId, openingBalance: opening || "0", shiftType: "RECEPTION" })}
          >
            {openShiftM.isPending ? "جارٍ الفتح…" : "فتح وردية خدمة الزبائن"}
          </Button>
          <Link href="/" className="mt-3 block text-center text-sm text-muted-foreground">← الرئيسية</Link>
        </div>
      </div>
    );
  }

  // تسوية الصندوق (نافذة الإغلاق): المتوقَّع = الافتتاحي + نقد وارد − نقد صادر (DRAWER).
  const recCashIn = (reportQ.data?.payments ?? [])
    .filter((p) => p.method === "CASH" && p.direction === "IN")
    .reduce((s, p) => s + Number(p.total), 0);
  const recCashOut = (reportQ.data?.payments ?? [])
    .filter((p) => p.method === "CASH" && p.direction === "OUT")
    .reduce((s, p) => s + Number(p.total), 0);
  const recExpected = Number(shift.openingBalance ?? 0) + recCashIn - recCashOut;
  const recDiff = counted ? Number(counted) - recExpected : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" dir="rtl">
      {/* نافذة إغلاق وردية خدمة الزبائن (Z-report مستقلّ) */}
      {closing && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
          dir="rtl"
          onClick={() => setClosing(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-lg font-extrabold">إغلاق وردية خدمة الزبائن #{shift.id}</h3>
            <p className="mb-4 text-xs text-muted-foreground">
              {new Date().toLocaleDateString("ar-IQ-u-nu-latn", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
            </p>
            {reportQ.isLoading ? (
              <div className="py-6 text-center text-muted-foreground">جارٍ تحميل التقرير…</div>
            ) : (
              <>
                {(
                  [
                    ["عدد الفواتير", `${reportQ.data?.invoiceCount ?? 0}`],
                    ["إجمالي المبيعات", `${fmt(Number(reportQ.data?.salesTotal ?? 0))} د.ع`],
                    ["الرصيد الافتتاحي", `${fmt(Number(shift.openingBalance ?? 0))} د.ع`],
                    ["النقد المتوقَّع بالصندوق", `${fmt(recExpected)} د.ع`],
                  ] as [string, string][]
                ).map(([l, v]) => (
                  <div key={l} className="flex justify-between border-b py-2 text-sm">
                    <span className="text-muted-foreground">{l}</span>
                    <span className="font-bold tabular-nums" dir="ltr">{v}</span>
                  </div>
                ))}
                <div className="my-4">
                  <CashCounter
                    value={closeCounts}
                    onChange={(counts, total) => {
                      setCloseCounts(counts);
                      setCounted(total);
                    }}
                  />
                </div>
                <label className="mb-1.5 block text-sm font-bold">النقد المعدود في الصندوق (د.ع)</label>
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                  className="h-11 text-end text-lg font-extrabold tabular-nums"
                  placeholder="0"
                />
                {recDiff !== null && (
                  <div
                    className={cn(
                      "mt-2 inline-flex flex-wrap items-center gap-1 text-sm font-bold",
                      recDiff < 0 ? "text-destructive" : "text-emerald-600",
                    )}
                  >
                    <span>الفرق: {recDiff >= 0 ? "+" : ""}{fmt(recDiff)} د.ع</span>
                    {recDiff === 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Check aria-hidden className="size-3.5" /> مطابق تماماً
                      </span>
                    )}
                    {recDiff > 0 && <span>(زيادة)</span>}
                    {recDiff < 0 && <span>(عجز)</span>}
                  </div>
                )}
                <div className="mt-5 flex gap-2.5">
                  <Button variant="outline" className="flex-1" onClick={() => setClosing(false)}>
                    إلغاء
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={!counted || closeShiftM.isPending}
                    onClick={() => closeShiftM.mutate({ shiftId: shift.id, countedCash: counted, countedBreakdown: closeCounts })}
                  >
                    {closeShiftM.isPending ? "جارٍ الإغلاق…" : "إغلاق وطباعة Z"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* ─── شريط البحث + جسر الطباعة + الوارد ─── */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b bg-card px-4 py-2.5">
        <div className="relative max-w-[640px] flex-1">
          <Search aria-hidden className="pointer-events-none absolute inset-y-0 end-3 my-auto size-4 text-muted-foreground" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 160)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results[0]) {
                e.preventDefault();
                addRow(results[0]);
              }
            }}
            placeholder="امسح الباركود أو ابحث بالاسم / SKU…  (F2)"
            className="h-11 w-full rounded-xl border-[1.5px] border-primary/35 bg-muted/40 px-4 pe-11 text-sm font-semibold outline-none focus:border-primary"
          />
          {showDrop && debounced.trim().length >= 2 && (
            <div className="absolute inset-x-0 top-[calc(100%+6px)] z-40 max-h-[340px] overflow-y-auto rounded-xl border bg-card p-1.5 shadow-xl">
              {resultsEmpty && (
                <div className="p-5 text-center text-xs text-muted-foreground">
                  لا نتائج — جرّب اسماً آخر أو SKU
                </div>
              )}
              {results.map((r) => (
                <button
                  key={r.productUnitId}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addRow(r);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg p-2 text-right hover:bg-muted/60"
                >
                  <div
                    className={cn(
                      "grid size-10 flex-shrink-0 place-items-center rounded-lg",
                      r.isCustomizable ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700",
                    )}
                  >
                    {r.isCustomizable ? <Palette aria-hidden className="size-5" /> : <Package aria-hidden className="size-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{r.productName}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
                          r.isCustomizable ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700",
                        )}
                      >
                        {r.isCustomizable ? "تخصيص" : "جاهز"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground" dir="ltr">
                      <span className="text-right">{r.sku} · {r.unitName}</span>
                      {r.stockBase != null && r.stockBase > 0 && (
                        <span className="ms-2">· متوفّر: {r.stockBase}</span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-sm font-bold tabular-nums" dir="ltr">
                    {r.price ? fmt(r.price) : "—"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ms-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-700">
            <span className="size-2 animate-pulse rounded-full bg-violet-500" />
            وردية خدمة الزبائن #{shift.id}
          </div>
          <Button size="sm" variant="outline" onClick={() => setClosing(true)}>
            إغلاق الوردية
          </Button>
          <button
            type="button"
            onClick={() => setShowInbox(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-bold hover:bg-muted/60"
          >
            <MessageCircle aria-hidden className="size-4" />
            الوارد
            <span className="rounded-full bg-muted px-1.5 text-[10px] font-bold text-muted-foreground">قريباً</span>
          </button>
        </div>
      </div>

      {/* ─── الجسم: سلّة (يسار) + لوحة الدفع (يمين) ─── */}
      <div className="flex min-h-0 flex-1 flex-row-reverse gap-3 p-3">
        {/* ─ السلّة ─ */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-extrabold">
                <ShoppingCart aria-hidden className="size-4" /> الطلب الحالي
              </span>
              {cart.length > 0 && (
                <Badge variant="default" className="text-[11px]">
                  {cart.length} منتج · {cartCount} قطعة
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <SmartCustomerInput value={customer} onChange={setCustomer} className="w-56" placeholder="عميل نقدي" />
              {cart.length > 0 && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void clearCart()}>
                  تفريغ
                </Button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {cart.length === 0 ? (
              <div className="grid h-full place-items-center px-4 py-10 text-center text-muted-foreground">
                <div>
                  <ShoppingCart aria-hidden className="mx-auto size-10 opacity-40" />
                  <div className="mt-2 text-sm font-bold">السلة فارغة</div>
                  <div className="mt-1 text-xs">امسح الباركود أو ابحث لإضافة المنتجات</div>
                </div>
              </div>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-muted/50 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-2 text-center font-bold">#</th>
                    <th className="px-2 py-2 text-right font-bold">المنتج</th>
                    <th className="w-14 px-1 py-2 text-center font-bold">الوحدة</th>
                    <th className="w-24 px-1 py-2 text-center font-bold">السعر</th>
                    <th className="w-16 px-1 py-2 text-center font-bold">المخزون</th>
                    <th className="w-32 px-1 py-2 text-center font-bold">الكمية</th>
                    <th className="w-24 px-1 py-2 text-center font-bold">الإجمالي</th>
                    <th className="w-8 px-1 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const stockState = buildStockState(cart);
                    return cart.map((l, idx) => {
                    const isCustom = isCustomKind(l);
                    const total = isCustom ? customLineGrand(l) : lineTotal(l);
                    const selected = selKey === l.key;
                    const stock = stockState(l);
                    return (
                      <tr
                        key={l.key}
                        onClick={() => {
                          setSelKey(l.key);
                          if (!isCustom) setNumMode((m) => (m === "PAY" ? "QTY" : m));
                        }}
                        className={cn(
                          "cursor-pointer border-b align-top",
                          isCustom
                            ? "border-s-[3px] border-s-violet-500"
                            : stock.isOut
                              ? "border-s-[3px] border-s-destructive bg-destructive/5"
                              : stock.isShort
                                ? "border-s-[3px] border-s-amber-500 bg-amber-50"
                                : "border-s-[3px] border-s-emerald-500",
                          selected && "bg-primary/5",
                        )}
                      >
                        <td className="px-2 py-2.5 text-center text-xs font-bold text-muted-foreground">{idx + 1}</td>
                        <td className="px-2 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={cn(
                                "rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                                isCustom ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700",
                              )}
                            >
                              {isCustom ? "تخصيص" : "جاهز"}
                            </span>
                            <span className="text-sm font-bold">
                              {isCustom ? l.custom!.title : l.row.productName}
                            </span>
                            <span className="text-[10px] text-muted-foreground" dir="ltr">{l.row.sku}</span>
                            {!isCustom && stock.isOut && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-[10px] font-extrabold text-destructive-foreground">
                                نافذ — لا مخزون
                              </span>
                            )}
                            {!isCustom && stock.isShort && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-extrabold text-amber-50">
                                {stock.availInUnit === 0
                                  ? "لا يكفي لوحدة"
                                  : `المتاح ${stock.availInUnit} فقط`}
                              </span>
                            )}
                          </div>
                          {isCustom && (
                            <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50/50 p-2.5">
                              <div className="flex flex-wrap gap-1.5">
                                {l.custom!.size && (
                                  <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                    <Ruler aria-hidden className="size-3" /> {l.custom!.size}
                                  </span>
                                )}
                                {l.custom!.material && (
                                  <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                    <Layers aria-hidden className="size-3" /> {l.custom!.material}
                                  </span>
                                )}
                                {l.custom!.dueDate && (
                                  <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold" dir="ltr">
                                    {l.custom!.dueDate}
                                  </span>
                                )}
                                {l.custom!.hasDelivery && (
                                  <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                    <Truck aria-hidden className="size-3" /> توصيل
                                    {Number(l.custom!.deliveryCost) > 0 && (
                                      <span dir="ltr">+{fmt(l.custom!.deliveryCost)}</span>
                                    )}
                                  </span>
                                )}
                                <span
                                  className={cn(
                                    "rounded-md border px-2 py-0.5 text-[11px] font-bold",
                                    l.custom!.priority === "URGENT" && "bg-destructive/10 text-destructive border-destructive/30",
                                    l.custom!.priority === "NORMAL" && "bg-sky-500/10 text-sky-700 border-sky-500/30",
                                    l.custom!.priority === "LOW" && "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
                                  )}
                                >
                                  {l.custom!.priority === "URGENT" ? "عاجل" : l.custom!.priority === "NORMAL" ? "عادي" : "منخفض"}
                                </span>
                              </div>
                              {l.custom!.customizationText && (
                                <div className="mt-2 line-clamp-2 inline-flex items-start gap-1 text-[11px] leading-relaxed text-muted-foreground">
                                  <FileText aria-hidden className="size-3 mt-0.5 flex-shrink-0" />
                                  <span>{l.custom!.customizationText}</span>
                                </div>
                              )}
                              <div className="mt-2 flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] inline-flex items-center gap-1"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setShowCustomization({ row: l.row, editingKey: l.key });
                                  }}
                                >
                                  <Pencil aria-hidden className="size-3" /> تعديل التخصيص
                                </Button>
                                <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-[11px] font-bold text-muted-foreground">
                                  <ImageIcon aria-hidden className="size-3" /> صور: {l.custom!.designImages.length}
                                </span>
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-1 py-2.5 text-center text-xs text-muted-foreground">{l.row.unitName}</td>
                        <td className="px-1 py-2.5 text-center text-xs tabular-nums" dir="ltr">
                          {fmt(effectivePrice(l))}
                          {l.disc ? <div className="text-[10px] text-amber-600">−{l.disc}%</div> : null}
                        </td>
                        <td
                          className={cn(
                            "px-1 py-2.5 text-center text-xs font-bold tabular-nums",
                            isCustom ? "text-muted-foreground" : stock.isOut ? "text-destructive" : stock.isShort ? "text-amber-600" : "text-muted-foreground",
                          )}
                          dir="ltr"
                        >
                          {isCustom ? "—" : l.row.isService ? "∞" : stock.availInUnit}
                        </td>
                        <td className="px-1 py-1.5">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                changeQty(l.key, -1);
                              }}
                              className="grid size-8 place-items-center rounded-md border bg-card hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                              disabled={isCustom && l.qty <= 1}
                              title={isCustom && l.qty <= 1 ? "لا يُمكن تقليل كمية صنف مخصَّص دون ١ — احذف السطر بدلاً من ذلك" : "تقليل الكمية"}
                              aria-label="تقليل الكمية"
                            >
                              <Minus aria-hidden className="size-3.5" />
                            </button>
                            <span className="min-w-[28px] text-center text-sm font-extrabold tabular-nums" dir="ltr">{l.qty}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                changeQty(l.key, +1);
                              }}
                              className="grid size-8 place-items-center rounded-md border bg-card hover:bg-muted"
                              aria-label="زيادة الكمية"
                            >
                              <Plus aria-hidden className="size-3.5" />
                            </button>
                          </div>
                        </td>
                        <td className="px-1 py-2.5 text-center text-sm font-extrabold tabular-nums" dir="ltr">{fmt(total)}</td>
                        <td className="px-1 py-2.5 text-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeRow(l.key);
                            }}
                            className="text-muted-foreground hover:text-destructive"
                            aria-label="حذف الصنف"
                          >
                            <Trash2 aria-hidden className="size-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  });
                  })()}
                </tbody>
              </table>
            )}
          </div>

          {cart.length > 0 && (
            <div className="flex flex-shrink-0 items-center justify-between border-t bg-muted/40 px-4 py-2.5">
              <span className="text-xs text-muted-foreground">{cart.length} منتج · {cartCount} قطعة</span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs text-muted-foreground">المجموع:</span>
                <span className="text-2xl font-black tabular-nums" dir="ltr">{fmt(grandTotal)}</span>
                <span className="text-xs text-muted-foreground">د.ع</span>
              </div>
            </div>
          )}
        </div>

        {/* ─ لوحة الدفع ─ */}
        <div className="flex w-[408px] flex-shrink-0 flex-col overflow-hidden rounded-xl border bg-card">
          {/* رأس الإجمالي + التقسيم الهجين */}
          <div className="flex-shrink-0 border-b bg-muted/40 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">إجمالي الفاتورة</span>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-black tabular-nums tracking-tight" dir="ltr">{fmt(grandTotal)}</span>
                <span className="text-xs text-muted-foreground">د.ع</span>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-2">
                <div className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700">
                  <ShoppingCart aria-hidden className="size-3" /> بيع مباشر
                </div>
                <div className="mt-0.5 text-sm font-extrabold tabular-nums" dir="ltr">{fmt(sumDirect)}</div>
              </div>
              <div className="rounded-lg border border-violet-500/25 bg-violet-500/10 p-2">
                <div className="inline-flex items-center gap-1 text-[10px] font-bold text-violet-700">
                  <Printer aria-hidden className="size-3" /> أوامر مطبعة
                </div>
                <div className="mt-0.5 text-sm font-extrabold tabular-nums" dir="ltr">{fmt(sumCustom)}</div>
              </div>
            </div>
          </div>

          {/* شاشة المبلغ */}
          <div className="flex-shrink-0 px-3 pb-1 pt-2">
            <div className="flex min-h-[44px] items-center justify-between rounded-lg border-[1.5px] bg-muted/40 px-3 py-1.5">
              <span className="text-xs text-muted-foreground">
                {numMode === "QTY" && "الكمية للسطر المحدّد"}
                {numMode === "DISC" && "خصم % للسطر المحدّد"}
                {numMode === "PAY" && "المبلغ المدفوع"}
              </span>
              <span
                className={cn(
                  "text-2xl font-black tabular-nums",
                  numMode === "PAY" && isOwing && "text-amber-600",
                  numMode === "PAY" && isChange && "text-emerald-600",
                )}
                dir="ltr"
              >
                {numMode === "QTY" ? (cart.find((c) => c.key === selKey)?.qty ?? "—") : numMode === "DISC" ? `${cart.find((c) => c.key === selKey)?.disc ?? 0}%` : payInput || "0"}
              </span>
            </div>
          </div>

          {/* مبالغ سريعة */}
          <div className="flex flex-shrink-0 flex-wrap gap-1.5 px-3 py-1">
            {QUICK_AMTS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setQuickAmt(v)}
                className="h-7 rounded-md border-[1.5px] bg-card px-2 text-[11px] font-bold tabular-nums hover:bg-muted"
                dir="ltr"
              >
                {v.toLocaleString("en-US")}
              </button>
            ))}
            <button
              type="button"
              onClick={payAll}
              className="h-7 rounded-md border-[1.5px] border-primary bg-card px-2 text-[11px] font-extrabold text-primary hover:bg-primary/10"
            >
              = الكل
            </button>
          </div>

          {/* لوحة الأرقام */}
          <div className="flex-shrink-0 px-3 py-1">
            <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-1.5" dir="rtl">
              <button onClick={() => setNumMode("QTY")} className={cn("h-12 min-w-[60px] rounded-lg border-[1.5px] text-xs font-extrabold", numMode === "QTY" ? "border-amber-400 bg-amber-100 text-amber-900" : "bg-card hover:bg-muted")}>الكمية</button>
              <NumKey k="3" onPress={numPress} />
              <NumKey k="2" onPress={numPress} />
              <NumKey k="1" onPress={numPress} />

              <button onClick={() => setNumMode("DISC")} className={cn("h-12 min-w-[60px] rounded-lg border-[1.5px] text-sm font-extrabold", numMode === "DISC" ? "border-amber-400 bg-amber-100 text-amber-900" : "bg-card hover:bg-muted")}>%</button>
              <NumKey k="6" onPress={numPress} />
              <NumKey k="5" onPress={numPress} />
              <NumKey k="4" onPress={numPress} />

              <button onClick={() => setNumMode("PAY")} className={cn("h-12 min-w-[60px] rounded-lg border-[1.5px] text-xs font-extrabold", numMode === "PAY" ? "border-amber-400 bg-amber-100 text-amber-900" : "bg-card hover:bg-muted")}>المبلغ</button>
              <NumKey k="9" onPress={numPress} />
              <NumKey k="8" onPress={numPress} />
              <NumKey k="7" onPress={numPress} />

              <button onClick={() => numPress("DEL")} className="grid h-12 place-items-center rounded-lg border-[1.5px] bg-red-50 text-red-700 hover:bg-red-100" aria-label="حذف">
                <X aria-hidden className="size-4" />
              </button>
              <NumKey k="." onPress={numPress} />
              <NumKey k="0" onPress={numPress} />
              <button onClick={() => numPress("C")} className="h-12 rounded-lg border-[1.5px] bg-card text-xs font-extrabold text-muted-foreground hover:bg-muted">C</button>
            </div>
          </div>

          {/* طريقة الدفع */}
          <div className="flex-shrink-0 px-3 py-1.5">
            <div className="mb-1 text-[11px] font-bold text-muted-foreground">طريقة الدفع</div>
            <div className="flex gap-1.5">
              {(
                [
                  { v: "CASH", label: "نقداً", Icon: Banknote, disabled: false },
                  { v: "CARD", label: "بطاقة", Icon: CreditCard, disabled: false },
                  { v: "TRANSFER", label: "تحويل", Icon: ArrowLeftRight, disabled: transferDisabled },
                ] as const
              ).map((p) => (
                <button
                  key={p.v}
                  onClick={() => !p.disabled && setMethod(p.v)}
                  disabled={p.disabled}
                  title={p.disabled ? "غير مدعوم لأوامر الشغل (CASH/CARD فقط)" : ""}
                  className={cn(
                    "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border-2 py-2 text-xs font-extrabold transition-colors",
                    p.disabled
                      ? "bg-muted/30 text-muted-foreground opacity-50 cursor-not-allowed"
                      : method === p.v
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-card hover:bg-muted",
                  )}
                >
                  <p.Icon aria-hidden className="size-5" />
                  {p.label}
                </button>
              ))}
            </div>
            {needPaymentRef && (
              <Input
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="رقم العملية / المرجع (إلزامي للبطاقة)"
                className="mt-2 h-9 text-xs"
                dir="ltr"
              />
            )}
          </div>

          {/* مؤشّر فكّة/متبقّي */}
          <div className="flex flex-shrink-0 items-center justify-between border-t px-3 py-1.5 text-xs">
            {isChange && paid > 0 && (
              <>
                <span className="font-semibold text-emerald-700">الفكّة:</span>
                <span className="text-xl font-black tabular-nums text-emerald-700" dir="ltr">
                  {fmt(change)} <span className="text-[10px] font-medium">د.ع</span>
                </span>
              </>
            )}
            {isOwing && (
              <>
                <span className="font-semibold text-amber-700">متبقّي:</span>
                <span className="text-xl font-black tabular-nums text-amber-700" dir="ltr">
                  {fmt(remaining)} <span className="text-[10px] font-medium">د.ع</span>
                </span>
              </>
            )}
            {!isChange && !isOwing && (
              <span className="text-muted-foreground">المتوقّع الآن: <span className="font-bold tabular-nums" dir="ltr">{fmt(expectedNow)} د.ع</span></span>
            )}
          </div>

          {/* الأزرار الكبيرة */}
          <div className="flex-shrink-0 space-y-1.5 px-3 pb-3 pt-1">
            <button
              type="button"
              disabled={cart.length === 0 || submitting || !shift}
              onClick={() => void handleSubmit({ quickFullPay: true })}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 text-sm font-black text-white shadow-md transition hover:bg-amber-600 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
            >
              <Zap aria-hidden className="size-4" /> دفع سريع وطباعة
            </button>
            <button
              type="button"
              disabled={cart.length === 0 || submitting || !shift}
              onClick={() => void handleSubmit({ quickFullPay: false })}
              className="inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-sm font-black text-primary-foreground shadow-md transition hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
            >
              {submitting ? (
                "جارٍ الإرسال…"
              ) : sumCustom > 0 && sumDirect > 0 ? (
                <><Printer aria-hidden className="size-4" /> إرسال أوامر الشغل ودفع البيع</>
              ) : sumCustom > 0 ? (
                <><Printer aria-hidden className="size-4" /> إرسال للمطبعة</>
              ) : (
                <><Check aria-hidden className="size-4" /> إتمام الدفع وطباعة</>
              )}
            </button>
            <div className="text-center text-[10px] text-muted-foreground">F4 دفع · F2 بحث</div>
          </div>
        </div>
      </div>

      {/* ─── نافذة التخصيص ─── */}
      {showCustomization && (
        <CustomizationDialog
          open
          productName={showCustomization.row.productName}
          price={showCustomization.row.price ?? "0"}
          initial={
            showCustomization.editingKey
              ? cart.find((c) => c.key === showCustomization.editingKey)?.custom
              : emptyCustomization(showCustomization.row.productName, showCustomization.row.price ?? "0")
          }
          onCancel={() => setShowCustomization(null)}
          onSave={saveCustomization}
        />
      )}

      {/* ─── درج الوارد (Stub) ─── */}
      {showInbox && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={() => setShowInbox(false)} />
          <aside className="fixed inset-y-0 end-0 z-50 flex w-[360px] max-w-[92vw] flex-col bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b p-4">
              <div className="inline-flex items-center gap-2 font-extrabold">
                <MessageCircle aria-hidden className="size-4" /> صندوق الوارد الموحّد
              </div>
              <button onClick={() => setShowInbox(false)} className="grid size-8 place-items-center rounded-md bg-muted hover:bg-muted/80" aria-label="إغلاق">
                <X aria-hidden className="size-4" />
              </button>
            </div>
            <div className="border-b bg-primary/5 p-3 text-xs leading-relaxed">
              تكامل القنوات (واتساب Business / انستغرام / المتجر) <b>قيد التنفيذ</b> — هذه معاينة فقط.
              عند الاكتمال، يُمكنك الردّ على العميل وتحويل محادثته إلى طلب خدمة من هنا مباشرة.
            </div>
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              <div>
                <MessageCircle aria-hidden className="mx-auto size-10 opacity-40" />
                <div className="mt-3 font-bold">لا محادثات بعد</div>
                <div className="mt-1 text-xs">تظهر هنا تلقائياً عند ربط القنوات.</div>
              </div>
            </div>
            <div className="border-t bg-muted/30 p-3">
              <div className="text-[11px] text-muted-foreground">قناة الطلب الحالي</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(
                  [
                    { v: "WALK_IN", label: "مباشر", Icon: Store },
                    { v: "WHATSAPP", label: "واتساب", Icon: MessageCircle },
                    { v: "INSTAGRAM", label: "انستغرام", Icon: Camera },
                    { v: "TIKTOK", label: "تيك توك", Icon: Music },
                    { v: "PHONE", label: "اتصال", Icon: Phone },
                  ] as const
                ).map((c) => (
                  <button
                    key={c.v}
                    onClick={() => setChannel(c.v)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-bold transition-colors",
                      channel === c.v ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted",
                    )}
                  >
                    <c.Icon aria-hidden className="size-3.5" /> {c.label}
                  </button>
                ))}
              </div>
              {channel !== "WALK_IN" && (
                <input
                  value={channelHandle}
                  onChange={(e) => setChannelHandle(e.target.value)}
                  placeholder="معرّف القناة (رقم/يوزر)"
                  className="mt-2 h-9 w-full rounded-md border bg-card px-2 text-xs"
                  dir="ltr"
                />
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

function NumKey({ k, onPress }: { k: string; onPress: (k: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPress(k)}
      className="h-12 rounded-lg border-[1.5px] bg-muted/40 text-lg font-extrabold tabular-nums hover:bg-muted"
      dir="ltr"
    >
      {k}
    </button>
  );
}
