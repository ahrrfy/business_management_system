import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { SmartCustomerInput, type SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { confirm } from "@/lib/confirm";
import { D, fmt } from "@/lib/money";
import { esc } from "@/lib/printing/brand";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";

/**
 * طلب خدمة جديد — v3 add-screens (شاشة احترافية متكاملة).
 *
 * تصميم — ٧ أقسام:
 *  ١) قنوات الاستلام (واتساب/انستغرام/تيك توك/هاتف/مباشر) + معرّف القناة.
 *  ٢) العميل الذكي — يتعرّف تلقائياً ويُنشئ عميلاً جديداً عند الحفظ.
 *  ٣) نقطة بيع مصغّرة — بحث بالباركود/الاسم + جدول سلّة + خصم.
 *  ٤) خدمة التخصيص — عنوان الأمر + نصّ التخصيص + التكاليف + تسليم.
 *  ٥) صور نموذج العمل المطلوب.
 *  ٦) التوصيل — عنوان + تكلفة (تُضاف للحساب).
 *  ٧) الدفع — نقدي/بطاقة + رقم مرجعي + إيصال للبطاقة.
 *
 * ملاحظة دمج: شريحة fin-medium المتزامنة تملك `workOrderRouter.ts` ⇒ لا نضيف حقولاً
 * للـAPI. نمرّر البيانات الإضافيّة عبر `customizationText` ك‍JSON موحَّد (مفاتيح `_v3`).
 * عند تحرير الجلسة المالكة، يمكن نقل المفاتيح إلى أعمدة DB المضافة في `drizzle/schema.ts`.
 */

const CHANNELS: { v: string; label: string; icon: string; placeholder: string; dir: "ltr" | "rtl" }[] = [
  { v: "WHATSAPP",  label: "واتساب",       icon: "💬", placeholder: "+9647701234567", dir: "ltr" },
  { v: "INSTAGRAM", label: "انستغرام",     icon: "📷", placeholder: "@username",       dir: "ltr" },
  { v: "TIKTOK",    label: "تيك توك",       icon: "🎵", placeholder: "@username",       dir: "ltr" },
  { v: "PHONE",     label: "اتصال هاتفي",   icon: "📞", placeholder: "+9647701234567", dir: "ltr" },
  { v: "WALK_IN",   label: "عميل نقدي",    icon: "🏪", placeholder: "—",               dir: "rtl" },
  { v: "OTHER",     label: "أخرى",          icon: "📩", placeholder: "—",               dir: "rtl" },
];

const PRIORITIES: { v: "LOW" | "NORMAL" | "URGENT"; label: string; cls: string }[] = [
  { v: "LOW",     label: "منخفض",   cls: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30" },
  { v: "NORMAL",  label: "عادي",     cls: "bg-sky-500/10 text-sky-700 border-sky-500/30" },
  { v: "URGENT",  label: "عاجل",     cls: "bg-destructive/10 text-destructive border-destructive/30" },
];

const DELIVERY_METHODS = ["استلام من المحل", "توصيل للعميل", "شحن سريع"];

type SearchResult = {
  variantId: number;
  productUnitId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  barcode: string | null;
  unitName: string;
  conversionFactor: string;
  price: string | null;
  stockBase: number;
};

type CartItem = {
  key: number;
  variantId: number;
  productUnitId: number;
  productName: string;
  sku: string;
  unitName: string;
  conversionFactor: string;
  quantity: number;
  unitPrice: string;
  // الكمية بالوحدة الأساس (لإرسالها للـ materials في الـAPI الحالي).
  baseQuantityPerUnit: number;
};

export default function WorkOrderNew() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const staff = trpc.workOrders.assignableStaff.useQuery();
  const utils = trpc.useUtils();

  const [branchId, setBranchId] = useState<number | "">("");
  const effectiveBranch = branchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 1);

  // السلامة المخزنية/المحاسبية: الأصناف الجاهزة (السلّة) تُباع بفاتورة بيع مستقلّة عبر saleRouter
  // (خصم مخزون + COGS + قيد SALE)، لا داخل طلب الخدمة. يلزم وردية مفتوحة كنقطة البيع.
  const shiftQ = trpc.shifts.current.useQuery({ branchId: Number(effectiveBranch) }, { enabled: !!effectiveBranch });
  const shift = shiftQ.data;

  // ── (١) قنوات الاستلام ──────────────────────────────────────────
  const [channel, setChannel] = useState<string>("WALK_IN");
  const [channelHandle, setChannelHandle] = useState<string>("");

  // ── (٢) العميل الذكي ────────────────────────────────────────────
  const [customerSel, setCustomerSel] = useState<SmartCustomerValue>({
    customerId: null, name: "", phone: null, isNew: false,
  });
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  // ── (٣) سلّة المنتجات ──────────────────────────────────────────
  const [cart, setCart] = useState<CartItem[]>([]);
  const [search, setSearch] = useState("");
  const [discountAmount, setDiscountAmount] = useState("");
  const barcodeRef = useRef<HTMLInputElement | null>(null);

  const posList = trpc.catalog.posList.useQuery(
    { branchId: Number(effectiveBranch), tier: "RETAIL", query: search, limit: 20 },
    { enabled: !!effectiveBranch && search.trim().length >= 2, staleTime: 15_000 }
  );

  // قراءة الباركود الفوريّة عند Enter ⇒ بحث دقيق ثم إضافة مباشرة.
  function handleBarcodeEnter() {
    const code = search.trim();
    if (!code) return;
    utils.catalog.byBarcode.fetch({ barcode: code, branchId: Number(effectiveBranch), tier: "RETAIL" }).then((row) => {
      if (row) {
        addRow({
          variantId: row.variantId,
          productUnitId: row.productUnitId,
          productName: row.productName,
          variantName: row.variantName,
          sku: row.sku,
          barcode: row.barcode,
          unitName: row.unitName,
          conversionFactor: row.conversionFactor,
          price: row.price,
          stockBase: row.stockBase,
        });
        setSearch("");
        barcodeRef.current?.focus();
      }
    }).catch(() => { /* ignore: لو فشل، ندع المستخدم يبحث يدوياً */ });
  }

  function addRow(r: SearchResult) {
    setCart((prev) => {
      const same = prev.find((c) => c.productUnitId === r.productUnitId);
      if (same) {
        return prev.map((c) => c.productUnitId === r.productUnitId ? { ...c, quantity: c.quantity + 1 } : c);
      }
      const k = prev.length ? Math.max(...prev.map((c) => c.key)) + 1 : 1;
      return [...prev, {
        key: k,
        variantId: r.variantId,
        productUnitId: r.productUnitId,
        productName: r.productName,
        sku: r.sku,
        unitName: r.unitName,
        conversionFactor: r.conversionFactor,
        quantity: 1,
        unitPrice: r.price || "0",
        baseQuantityPerUnit: Math.max(1, Math.trunc(Number(r.conversionFactor || "1"))),
      }];
    });
  }

  function updateQty(key: number, delta: number) {
    setCart((prev) => prev.map((c) => c.key === key ? { ...c, quantity: Math.max(1, c.quantity + delta) } : c));
  }
  function setQty(key: number, q: number) {
    setCart((prev) => prev.map((c) => c.key === key ? { ...c, quantity: Math.max(1, Math.trunc(q || 1)) } : c));
  }
  function setPrice(key: number, p: string) {
    setCart((prev) => prev.map((c) => c.key === key ? { ...c, unitPrice: p } : c));
  }
  function removeRow(key: number) {
    setCart((prev) => prev.filter((c) => c.key !== key));
  }

  // ── (٤) خدمة التخصيص ───────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [customizationText, setCustomizationText] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [salePrice, setSalePrice] = useState("");
  const [laborCost, setLaborCost] = useState("0");
  const [priority, setPriority] = useState<"LOW" | "NORMAL" | "URGENT">("NORMAL");
  const [assignedTo, setAssignedTo] = useState<number | "">("");
  const [deliveryMethod, setDeliveryMethod] = useState(DELIVERY_METHODS[0]);
  const [dueDate, setDueDate] = useState("");

  // ── (٥) صور نموذج العمل ────────────────────────────────────────
  const [designImages, setDesignImages] = useState<ImageItem[]>([]);

  // ── (٦) التوصيل ────────────────────────────────────────────────
  const [hasDelivery, setHasDelivery] = useState(false);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryCost, setDeliveryCost] = useState("");

  // ── (٧) الدفع ──────────────────────────────────────────────────
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "CARD">("CASH");
  const [deposit, setDeposit] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentReceipts, setPaymentReceipts] = useState<ImageItem[]>([]);

  // ── الحسابات ──────────────────────────────────────────────────
  const cartSubtotal = useMemo(
    () => cart.reduce((acc, c) => acc.plus(D(c.unitPrice).times(c.quantity)), D(0)),
    [cart]
  );
  const customizationTotal = useMemo(
    () => D(salePrice || "0").times(Math.max(1, parseInt(quantity || "1", 10) || 1)),
    [salePrice, quantity]
  );
  const discount = D(discountAmount || "0");
  const delivery = hasDelivery ? D(deliveryCost || "0") : D(0);
  // ── الملخّص الهجين (وثيقتان منفصلتان) ──────────────────────────
  // بيع مباشر (الأصناف الجاهزة): يُدفع كاملاً الآن بفاتورة بيع مستقلّة (خصم على السلّة يُطبَّق عليها).
  const saleTotal = cartSubtotal.minus(discount);
  // أمر التخصيص (المطبعة): سعر الخدمة + التوصيل = سعر بيع طلب الخدمة، يُقبض عليه عربون.
  const customTotal = customizationTotal.plus(delivery);
  const depositD = D(deposit || "0");
  const customRemaining = customTotal.minus(depositD);
  const hasCart = cart.length > 0;
  const hasCustom = customizationTotal.gt(0);
  const paidNow = (hasCart ? saleTotal : D(0)).plus(depositD); // المقبوض فوراً (بيع كامل + عربون)
  const grandTotal = saleTotal.plus(customTotal); // للعرض الكلّي فقط

  // ── الحفظ ──────────────────────────────────────────────────
  const [error, setError] = useState("");
  // idempotency: مفتاح ثابت للنموذج — يمنع إنشاء أمرين وقبض عربون مزدوج عند النقر المزدوج/إعادة الشبكة.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  // idempotency منفصل لفاتورة بيع الأصناف الجاهزة (وثيقة مستقلّة عن طلب الخدمة).
  const [saleRequestId, setSaleRequestId] = useState(() => crypto.randomUUID());

  const createCustomer = trpc.customers.create.useMutation();
  const createSale = trpc.sales.create.useMutation();
  const createWO = trpc.workOrders.create.useMutation({
    onSuccess: async (res, _vars, ctx) => {
      setClientRequestId(crypto.randomUUID());
      await utils.workOrders.list.invalidate();
      const id = (res as any)?.workOrderId ?? (res as any)?.id;
      // معالجة الطباعة بعد الحفظ.
      if ((ctx as any)?.shouldPrint && id) {
        window.open(`/work-orders/${id}?print=1`, "_blank");
      }
      navigate(`/work-orders/${id ?? ""}`);
    },
    onError: (e) => setError(e.message),
  });

  async function ensureCustomerId(): Promise<number | null> {
    if (customerSel.customerId) return customerSel.customerId;
    if (!customerSel.isNew || !customerSel.name.trim()) return null;
    // تأكيد إنشاء عميل ضمنيّ جديد قبل كتابته في القاعدة.
    if (!(await confirm({
      variant: "warning",
      title: "إنشاء عميل جديد",
      description: `سيُنشأ عميل جديد باسم «${customerSel.name.trim()}». متابعة؟`,
      confirmText: "إنشاء العميل",
    }))) return null;
    // أنشئ عميلاً جديداً تلقائياً.
    const created = await createCustomer.mutateAsync({
      name: customerSel.name.trim(),
      phone: (newCustomerPhone || customerSel.phone || "") || null,
      customerType: "فرد",
      defaultPriceTier: "RETAIL",
    });
    return Number((created as any).id ?? (created as any).customerId);
  }

  async function handleSave(opts: { print: boolean }) {
    setError("");
    if (!effectiveBranch) return setError("اختر الفرع.");
    if (!hasCart && !hasCustom) return setError("أضف منتجاً جاهزاً للسلّة أو أدخل خدمة تخصيص بسعر.");
    if (hasCustom && !salePrice.trim()) return setError("سعر بيع خدمة التخصيص مطلوب.");
    if (paymentMethod === "CARD" && !paymentReference.trim()) return setError("رقم العملية المرجعي مطلوب للبطاقة.");
    // الأصناف الجاهزة = فاتورة بيع تخصم النقد فوراً وتحدّث المخزون ⇒ تحتاج وردية مفتوحة (كنقطة البيع).
    if (hasCart && !shift) return setError("افتح وردية لبيع المنتجات الجاهزة (فاتورة مستقلّة)، أو أزِل المنتجات من السلّة.");
    if (hasCart && saleTotal.lte(0)) return setError("إجمالي السلّة بعد الخصم يجب أن يكون موجباً.");

    let customerId: number | null = null;
    try {
      customerId = await ensureCustomerId();
    } catch (e: any) {
      setError(e?.message || "تعذّر إنشاء العميل الجديد.");
      return;
    }

    // تأكيد نهائيّ — يصف الوثيقتين والمبلغ المقبوض فوراً (بيع كامل + عربون) ولا رجعة فيه.
    const parts: string[] = [];
    if (hasCart) parts.push(`فاتورة بيع للأصناف الجاهزة بقيمة ${fmt(saleTotal.toFixed(2))} د.ع تُدفع كاملة`);
    if (hasCustom) parts.push(`طلب خدمة بقيمة ${fmt(customTotal.toFixed(2))} د.ع بعربون ${fmt(depositD.toFixed(2))} د.ع`);
    if (!(await confirm({
      variant: "danger",
      title: "تأكيد الاستلام (يقبض نقداً) لا رجعة فيه",
      description: `سيُنشأ: ${parts.join(" + ")}. إجمالي المقبوض الآن ${fmt(paidNow.toFixed(2))} د.ع. اكتب «تأكيد» للمتابعة.`,
      confirmText: "تأكيد الاستلام",
      requireText: "تأكيد",
    }))) return;

    // ── (١) الأصناف الجاهزة → فاتورة بيع مستقلّة (خصم مخزون + COGS + قيد SALE) ──
    if (hasCart) {
      try {
        await createSale.mutateAsync({
          branchId: Number(effectiveBranch),
          shiftId: shift!.id,
          sourceType: "WORKORDER",
          customerId: customerId ?? undefined,
          priceTier: "RETAIL",
          lines: cart.map((c) => ({
            variantId: c.variantId,
            productUnitId: c.productUnitId,
            quantity: String(c.quantity),
            unitPriceOverride: D(c.unitPrice).toFixed(2),
          })),
          invoiceDiscount: discount.gt(0) ? discount.toFixed(2) : undefined,
          payment: { amount: saleTotal.toFixed(2), method: paymentMethod },
          cashRoundIQD: paymentMethod === "CASH",
          clientRequestId: saleRequestId,
        } as any);
        setSaleRequestId(crypto.randomUUID());
        await utils.shifts.current.invalidate();
      } catch (e: any) {
        setError(e?.message || "تعذّر إتمام بيع الأصناف الجاهزة.");
        return;
      }
    }

    // ── (٢) خدمة التخصيص → طلب خدمة (سعر = التخصيص + التوصيل، بلا أصناف بيع) ──
    if (!hasCustom) {
      // طلب أصناف جاهزة فقط بلا تخصيص ⇒ لا طلب خدمة؛ ننتقل لقائمة الفواتير.
      setCart([]);
      navigate("/invoices");
      return;
    }

    createWO.mutate({
      branchId: Number(effectiveBranch),
      clientRequestId,
      customerId: customerId ?? null,
      // أمر التخصيص خدمةٌ خالصة بلا منتج أساس (الأصناف الجاهزة بيعت بفاتورتها).
      baseVariantId: null,
      title: title.trim() || "طلب خدمة",
      customizationText: customizationText.trim() || null,
      quantity: Math.max(1, parseInt(quantity || "1", 10) || 1),
      materials: [],
      laborCost: D(laborCost || "0").toFixed(2),
      salePrice: customTotal.toFixed(2),
      dueDate: dueDate || null,
      notes: null,
      receptionChannel: channel as any,
      channelHandle: channelHandle.trim() || null,
      priority,
      assignedTo: assignedTo ? Number(assignedTo) : undefined,
      deposit: depositD.toFixed(2),
      paymentMethod,
      paymentReference: paymentReference.trim() || null,
      paymentReceiptUrl: paymentReceipts[0]?.dataUrl || null,
      hasDelivery,
      deliveryAddress: hasDelivery ? deliveryAddress.trim() || null : null,
      deliveryCost: hasDelivery ? D(deliveryCost || "0").toFixed(2) : "0",
      designImages: designImages.map((i, idx) => ({
        url: i.dataUrl,
        caption: i.name || null,
        sortOrder: idx,
      })),
    } as any, { context: { shouldPrint: opts.print } } as any);
  }

  function exportImage() {
    // تصدير ملخص بصري: نولّد بطاقة HTML نظيفة ثم نطبعها أو نحوّلها لـPNG عبر canvas بسيط.
    // الحلّ الكامل (html2canvas) ثقيل؛ هنا نفتح نافذة طباعة تتضمّن الملخّص، يستطيع المستخدم
    // «حفظ كصورة» عبر طباعة-إلى-PDF ثم تحويل، أو يستخدم الزرّ المستقبلي «تنزيل PNG».
    const w = window.open("", "_blank", "width=720,height=900");
    if (!w) return;
    const rows = cart.map((c) => `<tr><td>${esc(c.productName)}</td><td>${esc(c.unitName)}</td><td>${c.quantity}</td><td>${esc(fmt(c.unitPrice))}</td></tr>`).join("");
    w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>طلب خدمة</title>
      <style>body{font-family:Cairo,sans-serif;padding:24px;color:#222}h1{margin:0 0 12px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:right}thead{background:#f4f4f5}.muted{color:#666;font-size:13px}.total{font-weight:700;font-size:16px;margin-top:8px}</style>
      </head><body>
      <h1>طلب خدمة — معاينة</h1>
      <p class="muted">العميل: ${esc(customerSel.name || "—")} ${customerSel.isNew ? "(جديد)" : ""}</p>
      <p class="muted">القناة: ${esc(CHANNELS.find((c) => c.v === channel)?.label || "—")} ${channelHandle ? `· <bdi>${esc(channelHandle)}</bdi>` : ""}</p>
      <p class="muted">الأولوية: ${esc(PRIORITIES.find((p) => p.v === priority)?.label || "عادي")}</p>
      <table><thead><tr><th>المنتج</th><th>الوحدة</th><th>الكمية</th><th>السعر</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="muted">لا منتجات</td></tr>`}</tbody></table>
      ${title ? `<p><b>خدمة التخصيص:</b> ${esc(title)}</p>` : ""}
      <p class="total">الإجمالي: ${esc(fmt(grandTotal.toFixed(2)))} د.ع</p>
      <p>العربون: ${esc(fmt(depositD.toFixed(2)))} د.ع · متبقّي التخصيص: ${esc(fmt(customRemaining.toFixed(2)))} د.ع</p>
      <script>setTimeout(()=>window.print(),300)</script>
      </body></html>`);
    w.document.close();
  }

  // التركيز التلقائي على البحث عند فتح الصفحة لتسريع العمل.
  useEffect(() => { barcodeRef.current?.focus(); }, []);

  const channelDef = CHANNELS.find((c) => c.v === channel)!;
  const customerNeedsPhone = customerSel.isNew && !customerSel.phone;

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">طلب خدمة جديد</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportImage}>تحميل/طباعة كصورة</Button>
          <Link href="/work-orders" className="text-sm text-muted-foreground">← رجوع</Link>
        </div>
      </div>

      {/* مَلّاحة سَريعة بِخُطوات النَموذَج — انقر للقَفز للقِسم */}
      <Card className="overflow-hidden">
        <CardContent className="p-3 flex flex-wrap items-center justify-center gap-1.5 sm:gap-3">
          {[
            { id: "sec-channel",  n: 1, label: "القناة",   done: !!channel },
            { id: "sec-customer", n: 2, label: "العميل",   done: !!customerSel.name },
            { id: "sec-cart",     n: 3, label: "المنتجات", done: hasCart },
            { id: "sec-service",  n: 4, label: "التخصيص",  done: hasCustom },
            { id: "sec-images",   n: 5, label: "الصور",    done: designImages.length > 0 },
            { id: "sec-delivery", n: 6, label: "التوصيل",  done: !hasDelivery || !!deliveryAddress.trim() },
            { id: "sec-payment",  n: 7, label: "الدفع",    done: depositD.gt(0) || customRemaining.eq(0) },
          ].map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="flex items-center gap-1.5 text-xs font-medium hover:text-primary transition-colors"
            >
              <span
                aria-label={s.done ? "مُكتمَل" : "قَيد التَعبئة"}
                className={cn(
                  "flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold transition-colors",
                  s.done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground border"
                )}
              >
                {s.done ? "✓" : s.n}
              </span>
              <span className="hidden sm:inline">{s.label}</span>
            </button>
          ))}
        </CardContent>
      </Card>

      {/* ── (١) قناة الاستلام ─────────────────────────────────── */}
      <Card id="sec-channel">
        <CardHeader><CardTitle className="text-base">قناة الاستلام</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((c) => (
              <button
                key={c.v}
                type="button"
                onClick={() => setChannel(c.v)}
                className={cn(
                  "h-9 px-3 rounded-md border text-sm flex items-center gap-1.5 transition-colors",
                  channel === c.v ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"
                )}
              >
                <span>{c.icon}</span>
                <span>{c.label}</span>
              </button>
            ))}
          </div>
          {channel !== "WALK_IN" && (
            <div className="space-y-1 max-w-md">
              <Label htmlFor="handle">معرّف القناة</Label>
              {(channel === "WHATSAPP" || channel === "PHONE") ? (
                <IntlPhoneInput id="handle" value={channelHandle} onChange={setChannelHandle} />
              ) : (
                <Input id="handle" value={channelHandle} onChange={(e) => setChannelHandle(e.target.value)} placeholder={channelDef.placeholder} dir={channelDef.dir} />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── (٢) العميل الذكي ─────────────────────────────────── */}
      <Card id="sec-customer">
        <CardHeader><CardTitle className="text-base">العميل</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <SmartCustomerInput value={customerSel} onChange={setCustomerSel} />
          {customerNeedsPhone && (
            <div className="space-y-1 max-w-md">
              <Label htmlFor="newPh">رقم الهاتف للعميل الجديد</Label>
              <IntlPhoneInput id="newPh" value={newCustomerPhone} onChange={setNewCustomerPhone} />
              <p className="text-[11px] text-muted-foreground">سيُحفظ مع العميل الجديد تلقائياً عند حفظ الأمر.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── (٣) المنتجات والخدمات — نقطة بيع مصغّرة ─────────── */}
      <Card id="sec-cart">
        <CardHeader>
          <CardTitle className="text-base">المنتجات الجاهزة — بيع مباشر</CardTitle>
          <p className="text-[11px] text-muted-foreground">تُباع بفاتورة بيع مستقلّة (خصم فوري من المخزون) — منفصلة عن أمر التخصيص. تتطلّب وردية مفتوحة.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2 space-y-1">
              <Label htmlFor="bc">بحث بالباركود أو الاسم</Label>
              <div className="relative">
                <Input
                  id="bc"
                  ref={barcodeRef}
                  value={search}
                  dir="auto"
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleBarcodeEnter(); } }}
                  placeholder="امسح الباركود (Enter للإضافة) أو ابحث بالاسم/الـSKU"
                />
                {posList.isFetching && (
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">…</span>
                )}
              </div>
              {(search.trim().length >= 2) && (
                <div className="border rounded-md max-h-56 overflow-auto">
                  {(posList.data ?? []).length === 0 && !posList.isFetching && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">لا نتائج.</div>
                  )}
                  {(posList.data ?? []).map((r: any) => (
                    <button
                      key={`${r.variantId}-${r.productUnitId}`}
                      type="button"
                      onClick={() => { addRow(r); setSearch(""); barcodeRef.current?.focus(); }}
                      className="w-full text-right px-3 py-1.5 hover:bg-accent flex items-center justify-between text-sm border-b last:border-b-0"
                    >
                      <span className="flex flex-col items-start">
                        <span>{r.productName}</span>
                        <span className="text-[11px] text-muted-foreground" dir="ltr">{r.sku} · {r.unitName}</span>
                      </span>
                      <span className="flex items-center gap-1.5 text-xs">
                        <Badge variant="outline" dir="ltr">{r.stockBase} متوفّر</Badge>
                        <span className="font-medium" dir="ltr">{fmt(r.price || "0")}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label>الفرع</Label>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
                value={effectiveBranch}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
              >
                {(branches.data ?? []).map((b: any) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          {cart.length > 0 && (
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-right px-3 py-1.5 text-xs text-muted-foreground">المنتج</th>
                    <th className="text-center px-2 py-1.5 text-xs text-muted-foreground w-32">الكمية</th>
                    <th className="text-center px-2 py-1.5 text-xs text-muted-foreground w-28">السعر</th>
                    <th className="text-center px-2 py-1.5 text-xs text-muted-foreground w-28">الإجمالي</th>
                    <th className="text-center w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((c) => (
                    <tr key={c.key} className="border-t">
                      <td className="px-3 py-1.5">
                        <div>{c.productName}</div>
                        <div className="text-[11px] text-muted-foreground" dir="ltr">{c.sku} · {c.unitName}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center justify-center gap-1">
                          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => updateQty(c.key, -1)}>−</Button>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={c.quantity}
                            onChange={(e) => setQty(c.key, parseInt(e.target.value.replace(/\D/g, "") || "1", 10))}
                            className="w-12 h-7 text-center rounded border text-sm"
                            dir="ltr"
                          />
                          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => updateQty(c.key, 1)}>+</Button>
                        </div>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          dir="ltr"
                          value={c.unitPrice}
                          onChange={(e) => setPrice(c.key, e.target.value)}
                          className="w-full h-7 px-2 rounded border text-sm text-center"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-center font-medium" dir="ltr">{fmt(D(c.unitPrice).times(c.quantity).toFixed(2))}</td>
                      <td className="px-1 py-1.5 text-center">
                        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => removeRow(c.key)}>✕</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-between items-center text-sm pt-2">
            <div className="space-y-1">
              <Label htmlFor="disc" className="text-xs">خصم على السلّة (د.ع)</Label>
              <Input id="disc" dir="ltr" className="h-8 w-32" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} placeholder="0" />
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">إجمالي السلّة</div>
              <div className="font-bold text-lg" dir="ltr">{fmt(cartSubtotal.toFixed(2))} د.ع</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── (٤) خدمة التخصيص ──────────────────────────────────── */}
      <Card id="sec-service">
        <CardHeader><CardTitle className="text-base">خدمة التخصيص (المطبعة/التعديل)</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="title">عنوان الأمر</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: درع تكريمي بشعار الشركة" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="custom">نصّ التخصيص / تفاصيل العمل</Label>
            <Textarea id="custom" rows={3} value={customizationText} onChange={(e) => setCustomizationText(e.target.value)} placeholder="مثال: الاسم، الشعار، تاريخ التكريم…" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qty">الكمية</Label>
            <Input id="qty" dir="ltr" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, "") || "1")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sp">سعر بيع الوحدة (د.ع)</Label>
            <Input id="sp" dir="ltr" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} placeholder="0" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lc">تكلفة العمل اليدوي (د.ع)</Label>
            <Input id="lc" dir="ltr" value={laborCost} onChange={(e) => setLaborCost(e.target.value)} placeholder="0" />
            <p className="text-[11px] text-muted-foreground">للحساب الإداري فقط — لا تظهر للعميل.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="due">تاريخ التسليم المتوقّع</Label>
            <Input id="due" type="date" dir="ltr" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>الأولوية</Label>
            <div className="flex gap-2">
              {PRIORITIES.map((p) => (
                <button
                  key={p.v}
                  type="button"
                  onClick={() => setPriority(p.v)}
                  className={cn(
                    "h-9 px-3 rounded-md border text-xs font-medium transition-colors",
                    priority === p.v ? p.cls : "hover:bg-accent"
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="assignee">المنفّذ المسؤول</Label>
            <select
              id="assignee"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">— غير مُسنَد —</option>
              {(staff.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name ?? `#${s.id}`}{s.role ? ` — ${s.role}` : ""}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="dm">طريقة التسليم</Label>
            <select
              id="dm"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
              value={deliveryMethod}
              onChange={(e) => setDeliveryMethod(e.target.value)}
            >
              {DELIVERY_METHODS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      {/* ── (٥) صور نموذج العمل ──────────────────────────────── */}
      <Card id="sec-images">
        <CardHeader><CardTitle className="text-base">صور نموذج العمل المطلوب</CardTitle></CardHeader>
        <CardContent>
          <ImageUploader
            value={designImages}
            onChange={setDesignImages}
            maxItems={10}
            maxSizeMB={2}
            singlePrimary={false}
            hint="صور مرجعيّة من العميل لإرشاد عمليّة التصميم/التنفيذ."
          />
        </CardContent>
      </Card>

      {/* ── (٦) التوصيل ──────────────────────────────────────── */}
      <Card id="sec-delivery">
        <CardHeader><CardTitle className="text-base">التوصيل</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch checked={hasDelivery} onCheckedChange={setHasDelivery} id="delivery" />
            <Label htmlFor="delivery" className="cursor-pointer">{hasDelivery ? "نعم — يحتاج توصيلاً" : "لا — استلام من المحل"}</Label>
          </div>
          <div className={cn("grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity", hasDelivery ? "opacity-100" : "opacity-50 pointer-events-none")}>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="da">عنوان التوصيل</Label>
              <Textarea id="da" rows={2} value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} placeholder="بغداد، الكرادة، شارع …" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dc">تكلفة خدمة التوصيل (د.ع)</Label>
              <Input id="dc" dir="ltr" value={deliveryCost} onChange={(e) => setDeliveryCost(e.target.value)} placeholder="0" />
              <p className="text-[11px] text-muted-foreground">تُضاف للإجمالي النهائي.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── (٧) الدفع ────────────────────────────────────────── */}
      <Card id="sec-payment">
        <CardHeader><CardTitle className="text-base">الدفع والعربون</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPaymentMethod("CASH")}
              className={cn("h-10 px-4 rounded-md border text-sm flex items-center gap-1.5", paymentMethod === "CASH" ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent")}
            >
              💵 نقدي
            </button>
            <button
              type="button"
              onClick={() => setPaymentMethod("CARD")}
              className={cn("h-10 px-4 rounded-md border text-sm flex items-center gap-1.5", paymentMethod === "CARD" ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent")}
            >
              💳 بطاقة (ماستر/فيزا)
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="dep">عربون أمر التخصيص (د.ع)</Label>
              <Input id="dep" dir="ltr" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="0" />
              {customTotal.gt(0) && (
                <div className="flex gap-1.5 pt-1">
                  {[
                    { pct: 25, label: "٢٥٪" },
                    { pct: 50, label: "٥٠٪" },
                    { pct: 100, label: "كامِل" },
                  ].map((p) => (
                    <button
                      key={p.pct}
                      type="button"
                      onClick={() => setDeposit(customTotal.times(p.pct).dividedBy(100).toFixed(0))}
                      className="flex-1 h-8 text-xs font-semibold rounded-md border bg-muted/40 hover:bg-accent transition-colors"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">على أمر التخصيص فقط — الأصناف الجاهزة تُدفع كاملةً بفاتورتها.</p>
            </div>
            {paymentMethod === "CARD" && (
              <div className="space-y-1">
                <Label htmlFor="ref">رقم العملية المرجعي (AUTH) *</Label>
                <Input id="ref" dir="ltr" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="مثال: 482910" />
              </div>
            )}
          </div>

          {paymentMethod === "CARD" && (
            <div className="space-y-1">
              <Label>صورة إيصال البطاقة</Label>
              <ImageUploader
                value={paymentReceipts}
                onChange={setPaymentReceipts}
                maxItems={3}
                maxSizeMB={2}
                singlePrimary={false}
                hint="صورة الإيصال أو لقطة من الشاشة — حتى 3 ملفات."
              />
            </div>
          )}

          {/* الملخّص الهجين — وثيقتان: بيع مباشر (يُدفع كاملاً) + أمر تخصيص (عربون + متبقٍّ) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {/* بطاقة البيع المباشر */}
            <div className={cn("rounded-md border p-3 space-y-1", hasCart ? "bg-emerald-500/5 border-emerald-500/30" : "bg-muted/20 opacity-60")}>
              <div className="flex items-center justify-between font-semibold"><span>🛒 بيع مباشر (جاهز)</span>{hasCart && <Badge variant="outline" className="text-emerald-700 border-emerald-500/40">فاتورة مستقلّة</Badge>}</div>
              <div className="flex justify-between"><span>إجمالي السلّة</span><span dir="ltr">{fmt(cartSubtotal.toFixed(2))} د.ع</span></div>
              {discount.gt(0) && <div className="flex justify-between text-emerald-700"><span>− خصم</span><span dir="ltr">{fmt(discount.toFixed(2))} د.ع</span></div>}
              <div className="flex justify-between font-bold border-t pt-1"><span>يُدفع كاملاً الآن</span><span dir="ltr">{fmt(saleTotal.toFixed(2))} د.ع</span></div>
              {!shift && hasCart && <p className="text-[11px] text-destructive">يلزم وردية مفتوحة لبيع الأصناف الجاهزة.</p>}
            </div>
            {/* بطاقة أمر التخصيص */}
            <div className={cn("rounded-md border p-3 space-y-1", hasCustom ? "bg-violet-500/5 border-violet-500/30" : "bg-muted/20 opacity-60")}>
              <div className="flex items-center justify-between font-semibold"><span>🖨 أمر تخصيص (مطبعة)</span>{hasCustom && <Badge variant="outline" className="text-violet-700 border-violet-500/40">طلب خدمة</Badge>}</div>
              <div className="flex justify-between"><span>خدمة التخصيص ({quantity} × {fmt(salePrice || "0")})</span><span dir="ltr">{fmt(customizationTotal.toFixed(2))} د.ع</span></div>
              {hasDelivery && delivery.gt(0) && <div className="flex justify-between"><span>+ توصيل</span><span dir="ltr">{fmt(delivery.toFixed(2))} د.ع</span></div>}
              <div className="flex justify-between font-bold border-t pt-1"><span>سعر الأمر</span><span dir="ltr">{fmt(customTotal.toFixed(2))} د.ع</span></div>
              <div className="flex justify-between text-muted-foreground"><span>العربون</span><span dir="ltr">{fmt(depositD.toFixed(2))} د.ع</span></div>
              <div className="flex justify-between font-medium"><span>المتبقّي (آجل)</span><span dir="ltr">{fmt(customRemaining.toFixed(2))} د.ع</span></div>
            </div>
          </div>
          <div className="rounded-md border bg-primary/5 border-primary/30 p-3 flex justify-between items-center font-bold">
            <span>إجمالي المقبوض الآن</span>
            <span dir="ltr">{fmt(paidNow.toFixed(2))} د.ع</span>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => handleSave({ print: false })} disabled={createWO.isPending || createSale.isPending || createCustomer.isPending}>
          {createWO.isPending || createSale.isPending ? "جارٍ الحفظ…" : "حفظ"}
        </Button>
        <Button variant="default" onClick={() => handleSave({ print: true })} disabled={createWO.isPending || createSale.isPending}>
          🖨 حفظ وطباعة
        </Button>
        <Button variant="outline" onClick={exportImage}>
          📤 تحميل كصورة
        </Button>
        <Link href="/work-orders"><Button variant="ghost">إلغاء</Button></Link>
      </div>
    </div>
  );
}
