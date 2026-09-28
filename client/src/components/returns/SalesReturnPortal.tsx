/**
 * SalesReturnPortal — المنفذ الأول: مرتجعات المبيعات (العملاء والتجزئة)
 *
 * يشمل:
 *  - مسح الباركود السريع وسلة المنتجات التفاعلية
 *  - الفاتورة الأصلية (اختيارية) مع زر فحص
 *  - العميل المرتبط بـ CRM (ذكي واختياري)
 *  - المسار المخزني للصنف: رجوع للرف (Restock) أو تالف مسجل خسارة (Damaged)
 *  - طرق الاسترداد المالي: نقدي (درج الكاشير)، بطاقة، أو رصيد متجر
 *  - طباعة حرارية فورية 80مم/58مم
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Coins,
  CreditCard,
  FileCheck,
  Minus,
  Plus,
  Receipt,
  RotateCcw,
  ScanLine,
  ShoppingCart,
  Ticket,
  Trash2,
  UserCheck,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmt, formatQuantity } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { cn } from "@/lib/utils";
import {
  printSalesReturnReceipt,
  type PrintSalesReturnData,
} from "./printThermalReturnReceipt";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { InvoiceLine } from "@/components/invoice/types";

export interface SalesCartItem {
  id: string;
  variantId: number;
  productUnitId?: number;
  invoiceItemId?: number;
  isBundle?: boolean;
  productName: string;
  barcode?: string | null;
  quantity: number;
  maxAllowedQuantity?: number;
  unitPrice: string;
  originalUnitPrice?: string;
  unit?: string;
  conversionFactor?: number;
}

interface SalesReturnPortalProps {
  initialInvoiceNo?: string;
  onReturnSuccess: (data: PrintSalesReturnData) => void;
}

export function SalesReturnPortal({
  initialInvoiceNo,
  onReturnSuccess,
}: SalesReturnPortalProps) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const activeBranchId = me.data?.branchId
    ? Number(me.data.branchId)
    : Number(branches.data?.[0]?.id || 1);

  const [salesInvoiceNo, setSalesInvoiceNo] = useState(initialInvoiceNo ?? "");
  const [salesCustomerName, setSalesCustomerName] = useState("");
  const [salesCustomerPhone, setSalesCustomerPhone] = useState("");
  const [salesCustomerId, setSalesCustomerId] = useState<number | null>(null);
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const [salesCustomerSearch, setSalesCustomerSearch] = useState("");
  const debouncedCustomerSearch = useDebouncedValue(
    salesCustomerSearch.trim(),
    300,
  );

  const customersQuery = trpc.customers.smartSearch.useQuery(
    { q: debouncedCustomerSearch, limit: 6 },
    { enabled: debouncedCustomerSearch.length >= 2 },
  );

  const [salesDisposition, setSalesDisposition] = useState<
    "RESTOCK" | "DAMAGED"
  >("RESTOCK");
  const [salesBarcode, setSalesBarcode] = useState("");
  const [salesCart, setSalesCart] = useState<SalesCartItem[]>([]);
  const [salesRefundMethod, setSalesRefundMethod] = useState<
    "CASH" | "CARD" | "STORE_CREDIT"
  >("CASH");
  const [salesCardRef, setSalesCardRef] = useState("");
  const [salesReason, setSalesReason] = useState("");

  const openDrawersQ = trpc.returns.getOpenRefundDrawers.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const openDrawers = openDrawersQ.data ?? [];
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);

  useEffect(() => {
    if (openDrawers.length > 0 && selectedShiftId == null) {
      const mine = openDrawers.find((d) => d.isMine);
      if (mine) {
        setSelectedShiftId(mine.shiftId);
      } else {
        setSelectedShiftId(openDrawers[0].shiftId);
      }
    }
  }, [openDrawers, selectedShiftId]);

  const salesBarcodeRef = useRef<HTMLInputElement>(null);

  type InspectedInvoice = NonNullable<
    Awaited<ReturnType<typeof utils.returns.inspectInvoiceForReturn.fetch>>
  >;
  const [inspectedInvoice, setInspectedInvoice] =
    useState<InspectedInvoice | null>(null);

  const salesTotal = useMemo(() => {
    return salesCart.reduce(
      (sum, item) => sum + item.quantity * Number(item.unitPrice || 0),
      0,
    );
  }, [salesCart]);

  const salesTotalPieces = useMemo(() => {
    return salesCart.reduce((sum, item) => sum + item.quantity, 0);
  }, [salesCart]);

  const selectedDrawer = useMemo(() => {
    return openDrawers.find((d) => d.shiftId === selectedShiftId) ?? null;
  }, [openDrawers, selectedShiftId]);

  const isInsufficientCash = useMemo(() => {
    return (
      selectedDrawer != null &&
      Number(selectedDrawer.expectedCash || 0) < salesTotal
    );
  }, [selectedDrawer, salesTotal]);

  const isOverInvoiceLimit = useMemo(() => {
    if (!inspectedInvoice) return false;
    return salesTotal > Number(inspectedInvoice.maxRefundable || 0);
  }, [inspectedInvoice, salesTotal]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "F2") return;
      e.preventDefault();
      const el = document.querySelector<HTMLInputElement>(
        "input[data-product-search='1']",
      );
      el?.focus();
      el?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleAddProductFromSearch = (line: InvoiceLine) => {
    const variantId = line.variantId;
    const factor = Math.max(1, Number(line.conversionFactor) || 1);

    const matchedInvItem = inspectedInvoice?.items.find(
      (it) => it.variantId === variantId,
    );

    if (inspectedInvoice && !matchedInvItem) {
      notify.warn(
        `تنبيه: الصنف «${line.name}» غير مسجل ضمن بنود الفاتورة #${inspectedInvoice.invoiceNumber}`,
      );
    }

    const priceStr = matchedInvItem
      ? matchedInvItem.unitPrice
      : String(line.price || "0");
    const maxQty = matchedInvItem
      ? matchedInvItem.remainingQuantity
      : undefined;

    setSalesCart((prev) => {
      const existingIdx = prev.findIndex((i) =>
        matchedInvItem
          ? i.invoiceItemId === matchedInvItem.invoiceItemId
          : i.variantId === variantId,
      );
      if (existingIdx >= 0) {
        const target = prev[existingIdx];
        const updated = [...prev];
        let newQty = target.quantity + (line.qty || 1);
        if (maxQty != null && newQty > maxQty) {
          notify.warn(
            `الكمية المطلوبة تتجاوز المتبقي في الفاتورة (${formatQuantity(maxQty)})`,
          );
          newQty = maxQty;
        }
        const [moved] = updated.splice(existingIdx, 1);
        const itemToPlace = { ...moved, quantity: newQty };
        setLastAddedId(itemToPlace.id);
        return [itemToPlace, ...updated];
      }
      const newId = `${variantId}-${Date.now()}`;
      setLastAddedId(newId);
      const initialQty = Math.min(line.qty || 1, maxQty ?? (line.qty || 1));
      return [
        {
          id: newId,
          variantId,
          productUnitId: line.productUnitId,
          invoiceItemId: matchedInvItem?.invoiceItemId,
          isBundle: matchedInvItem?.isBundle,
          productName: line.name,
          barcode: line.barcode ?? null,
          quantity: initialQty,
          maxAllowedQuantity: maxQty,
          unitPrice: priceStr,
          originalUnitPrice: matchedInvItem
            ? matchedInvItem.unitPrice
            : undefined,
          unit: line.unit || "قطعة",
          conversionFactor: factor,
        },
        ...prev,
      ];
    });

    notify.ok(`أُضيف للسلة: ${line.name}`);
  };

  const [salesScanPending, setSalesScanPending] = useState(false);
  const handleSalesScan = async (barcodeToScan?: string) => {
    const raw = (barcodeToScan ?? salesBarcode).trim();
    if (!raw) return;
    setSalesScanPending(true);
    try {
      const res = await utils.returns.lookupItemForReturn.fetch({
        barcode: raw,
      });
      if (!res) {
        notify.warn(`لم يتم العثور على منتج بالباركود: ${raw}`);
        return;
      }
      const variantId = res.variantId;
      const matchedInvItem = inspectedInvoice?.items.find(
        (it) => it.variantId === variantId,
      );

      if (inspectedInvoice && !matchedInvItem) {
        notify.warn(
          `تنبيه: الصنف «${res.productName}» غير مسجل ضمن بنود الفاتورة #${inspectedInvoice.invoiceNumber}`,
        );
      }

      const priceStr = matchedInvItem
        ? matchedInvItem.unitPrice
        : String(res.retailPrice || res.lowestHistoricalPrice || "0");
      const maxQty = matchedInvItem?.remainingQuantity;

      setSalesCart((prev) => {
        const existingIdx = prev.findIndex((i) =>
          matchedInvItem
            ? i.invoiceItemId === matchedInvItem.invoiceItemId
            : i.variantId === variantId,
        );
        if (existingIdx >= 0) {
          const target = prev[existingIdx];
          const updated = [...prev];
          let newQty = target.quantity + 1;
          if (maxQty != null && newQty > maxQty) {
            notify.warn(
              `الكمية المطلوبة تتجاوز المتبقي في الفاتورة (${formatQuantity(maxQty)})`,
            );
            newQty = maxQty;
          }
          const [moved] = updated.splice(existingIdx, 1);
          const itemToPlace = { ...moved, quantity: newQty };
          setLastAddedId(itemToPlace.id);
          return [itemToPlace, ...updated];
        }
        const newId = `${variantId}-${Date.now()}`;
        setLastAddedId(newId);
        return [
          {
            id: newId,
            variantId,
            productUnitId: res.productUnitId,
            invoiceItemId: matchedInvItem?.invoiceItemId,
            isBundle: matchedInvItem?.isBundle,
            productName: res.productName,
            barcode: res.barcode ?? raw,
            quantity: 1,
            maxAllowedQuantity: maxQty,
            unitPrice: priceStr,
            originalUnitPrice: matchedInvItem
              ? matchedInvItem.unitPrice
              : undefined,
          },
          ...prev,
        ];
      });

      setSalesBarcode("");
      notify.ok(`أُضيف للسلة: ${res.productName}`);
      salesBarcodeRef.current?.focus();
    } catch {
      notify.err("خطأ أثناء قراءة الصنف");
    } finally {
      setSalesScanPending(false);
    }
  };

  const [invoiceLookupLoading, setInvoiceLookupLoading] = useState(false);
  const handleLookupInvoice = async (targetNo?: string) => {
    const raw = (targetNo ?? salesInvoiceNo).trim();
    if (!raw) return;
    setInvoiceLookupLoading(true);
    try {
      // ١) فحص مباشر عبر إجراء حوكمة المرتجعات inspectInvoiceForReturn
      try {
        const inv = await utils.returns.inspectInvoiceForReturn.fetch({
          invoiceNumber: raw,
        });
        if (inv) {
          setInspectedInvoice(inv);
          setSalesCustomerName(inv.customerName ?? "عميل نقدي");
          if (inv.customerId) setSalesCustomerId(inv.customerId);
          if (inv.customerPhone) setSalesCustomerPhone(inv.customerPhone);
          setSalesInvoiceNo(inv.invoiceNumber);
          if (inv.isDead) {
            notify.warn(
              `الفاتورة #${inv.invoiceNumber} مغلقة أو ملغاة أو مرجعة بالكامل ولا تقبل مرتجعات`,
            );
          } else {
            notify.ok(
              `تم جلب الفاتورة #${inv.invoiceNumber} وسقف استردادها (${fmt(inv.maxRefundable)} د.ع)`,
            );
          }
          return;
        }
      } catch {
        // المتابعة للبحث البديل
      }

      // ٢) تجربة المسح الكوني الذكي لمعرفة ما إذا كان الرمز باركود فاتورة
      try {
        const scanRes = await utils.returns.universalScan.fetch({
          barcode: raw,
        });
        if (scanRes.recognized && scanRes.kind === "INVOICE" && scanRes.id) {
          const invData = await utils.sales.get.fetch({ invoiceId: scanRes.id });
          if (invData?.invoiceNumber) {
            const inspected = await utils.returns.inspectInvoiceForReturn.fetch({
              invoiceNumber: invData.invoiceNumber,
            });
            if (inspected) {
              setInspectedInvoice(inspected);
              setSalesCustomerName(inspected.customerName ?? "عميل نقدي");
              if (inspected.customerId) setSalesCustomerId(inspected.customerId);
              if (inspected.customerPhone)
                setSalesCustomerPhone(inspected.customerPhone);
              setSalesInvoiceNo(inspected.invoiceNumber);
              notify.ok(`تم التعرف على الفاتورة #${inspected.invoiceNumber}`);
              return;
            }
          }
        }
      } catch {
        // تجاهل والمتابعة
      }

      // ٣) استخراج الرقم والبحث المباشر
      const invId = parseInt(raw.replace(/\D/g, ""), 10);
      if (invId) {
        try {
          const invData = await utils.sales.get.fetch({ invoiceId: invId });
          if (invData?.invoiceNumber) {
            const inspected = await utils.returns.inspectInvoiceForReturn.fetch({
              invoiceNumber: invData.invoiceNumber,
            });
            if (inspected) {
              setInspectedInvoice(inspected);
              setSalesCustomerName(inspected.customerName ?? "عميل نقدي");
              if (inspected.customerId) setSalesCustomerId(inspected.customerId);
              if (inspected.customerPhone)
                setSalesCustomerPhone(inspected.customerPhone);
              setSalesInvoiceNo(inspected.invoiceNumber);
              notify.ok(`تم التعرف على الفاتورة #${inspected.invoiceNumber}`);
              return;
            }
          }
        } catch {
          // المتابعة للتقصي الذكي
        }
      }

      // ٤) التحري الذكي (forensic trace) بواسطة رقم الهاتف أو باركود الصنف
      try {
        const trace = await utils.returns.forensicTrace.fetch({
          query: raw,
          mode:
            /^\d+$/.test(raw) && raw.length >= 7
              ? "CUSTOMER_PHONE"
              : "ITEM_BARCODE",
          days: 90,
        });
        if (trace?.results && trace.results.length > 0) {
          const first = trace.results[0];
          const inspected = await utils.returns.inspectInvoiceForReturn.fetch({
            invoiceNumber: first.invoiceNumber,
          });
          if (inspected) {
            setInspectedInvoice(inspected);
            setSalesCustomerName(inspected.customerName ?? "عميل نقدي");
            if (inspected.customerId) setSalesCustomerId(inspected.customerId);
            if (inspected.customerPhone)
              setSalesCustomerPhone(inspected.customerPhone);
            setSalesInvoiceNo(inspected.invoiceNumber);
            notify.ok(
              `تم العثور على الفاتورة #${inspected.invoiceNumber} عبر التحري الذكي`,
            );
            return;
          }
        }
      } catch {
        // المتابعة
      }

      setInspectedInvoice(null);
      notify.warn(
        "لم يُعثر على فاتورة بهذا الرقم — يمكنك المتابعة بدون فاتورة كمرتجع عابر",
      );
    } catch {
      setInspectedInvoice(null);
      notify.warn("تعذر جلب الفاتورة — يمكنك المتابعة بدونها");
    } finally {
      setInvoiceLookupLoading(false);
    }
  };

  const handleAddInspectedItemToCart = (
    item: NonNullable<typeof inspectedInvoice>["items"][number],
  ) => {
    if (item.remainingQuantity <= 0) {
      notify.warn(`الصنف «${item.productName}» تم إرجاع كامل كميته مسبقاً`);
      return;
    }

    setSalesCart((prev) => {
      const existingIdx = prev.findIndex(
        (i) =>
          i.invoiceItemId === item.invoiceItemId ||
          (!i.invoiceItemId && i.variantId === item.variantId),
      );
      if (existingIdx >= 0) {
        const target = prev[existingIdx];
        if (target.quantity >= item.remainingQuantity) {
          notify.warn(
            `الكمية في السلة وصلت للحد الأقصى المتاح (${formatQuantity(item.remainingQuantity)})`,
          );
          return prev;
        }
        const updated = [...prev];
        const newQty = Math.min(item.remainingQuantity, target.quantity + 1);
        const [moved] = updated.splice(existingIdx, 1);
        const itemToPlace = { ...moved, quantity: newQty };
        setLastAddedId(itemToPlace.id);
        return [itemToPlace, ...updated];
      }

      const newId = `${item.variantId}-${Date.now()}`;
      setLastAddedId(newId);
      return [
        {
          id: newId,
          variantId: item.variantId,
          productUnitId: item.productUnitId,
          invoiceItemId: item.invoiceItemId,
          isBundle: item.isBundle,
          productName: item.productName,
          barcode: item.barcode,
          quantity: 1,
          maxAllowedQuantity: item.remainingQuantity,
          unitPrice: item.unitPrice,
          originalUnitPrice: item.unitPrice,
          unit: item.unitName,
          conversionFactor: item.conversionFactor,
        },
        ...prev,
      ];
    });

    notify.ok(`أُضيف للسلة: ${item.productName}`);
  };

  const handleAddAllRemainingItems = () => {
    if (!inspectedInvoice || inspectedInvoice.items.length === 0) return;
    const availableItems = inspectedInvoice.items.filter(
      (i) => i.remainingQuantity > 0,
    );
    if (availableItems.length === 0) {
      notify.warn("لا توجد بنود متبقية قابلة للإرجاع في هذه الفاتورة");
      return;
    }

    setSalesCart((prev) => {
      let nextCart = [...prev];
      for (const item of availableItems) {
        const existingIdx = nextCart.findIndex(
          (i) =>
            i.invoiceItemId === item.invoiceItemId ||
            (!i.invoiceItemId && i.variantId === item.variantId),
        );
        if (existingIdx >= 0) {
          nextCart[existingIdx] = {
            ...nextCart[existingIdx],
            quantity: item.remainingQuantity,
            maxAllowedQuantity: item.remainingQuantity,
            unitPrice: item.unitPrice,
            originalUnitPrice: item.unitPrice,
          };
        } else {
          const newId = `${item.variantId}-${Date.now()}-${Math.random()}`;
          nextCart.push({
            id: newId,
            variantId: item.variantId,
            productUnitId: item.productUnitId,
            invoiceItemId: item.invoiceItemId,
            isBundle: item.isBundle,
            productName: item.productName,
            barcode: item.barcode,
            quantity: item.remainingQuantity,
            maxAllowedQuantity: item.remainingQuantity,
            unitPrice: item.unitPrice,
            originalUnitPrice: item.unitPrice,
            unit: item.unitName,
            conversionFactor: item.conversionFactor,
          });
        }
      }
      return nextCart;
    });

    notify.ok(
      `تمت إضافة ${availableItems.length} بند بكامل الكميات المتبقية للسلة`,
    );
  };

  useEffect(() => {
    if (initialInvoiceNo) {
      setSalesInvoiceNo(initialInvoiceNo);
      void handleLookupInvoice(initialInvoiceNo);
    }
  }, [initialInvoiceNo]);

  const salesReturnMutation = trpc.returns.executeSalesReturnCart.useMutation();

  const handleExecuteSalesReturn = async () => {
    if (salesCart.length === 0) {
      notify.warn("يرجى إضافة صنف واحد على الأقل للسلة");
      return;
    }
    if (salesTotal <= 0) {
      notify.warn("مبلغ الإرجاع غير صالح");
      return;
    }

    if (inspectedInvoice) {
      if (inspectedInvoice.isDead) {
        notify.warn(
          "لا يمكن تنفيذ مرتجع على هذه الفاتورة لأنها مغلقة أو ملغاة أو مرجعة بالكامل مسبقاً",
        );
        return;
      }
      if (isOverInvoiceLimit) {
        notify.warn(
          `إجمالي مبلغ المرتجع (${fmt(String(salesTotal))} د.ع) يتجاوز سقف الاسترداد المتبقي للفاتورة (${fmt(inspectedInvoice.maxRefundable)} د.ع)`,
        );
        return;
      }
    }

    if (salesRefundMethod === "CASH") {
      if (openDrawers.length === 0) {
        notify.warn(
          "لا توجد وردية كاشير مفتوحة حالياً في الفرع لصرف النقد منها — افتح وردية أولاً أو اختر طريقة أخرى",
        );
        return;
      }
      if (!selectedShiftId) {
        notify.warn(
          "يرجى اختيار درج النقدية / الوردية التي سيتم صرف المبلغ منها",
        );
        return;
      }
      if (isInsufficientCash) {
        const proceedAnyway = await confirm({
          title: "تنبيه نقص النقد في الدرج",
          description: `الرصيد المحسوب حالياً في درج (${selectedDrawer?.userName || "الكاشير"}) هو (${fmt(selectedDrawer?.expectedCash || "0")} د.ع)، وهو أقل من مبلغ المرتجع (${fmt(String(salesTotal))} د.ع). هل ترغب في المتابعة والتأكيد؟`,
          confirmText: "المتابعة على أي حال",
          variant: "warning",
        });
        if (!proceedAnyway) return;
      }
    } else if (salesRefundMethod === "STORE_CREDIT") {
      if (!salesCustomerId) {
        notify.warn(
          "طريقة استرداد رصيد المتجر تتطلب اختيار عميل مسجل في CRM لإيداع الرصيد في حسابه",
        );
        return;
      }
      // رصيد المتجر التزامٌ دائمٌ على حساب العميل ⇒ يجب ربطه بالفاتورة الأصليّة (نفس ما يفرضه
      // الخادم): بلا فاتورةٍ لا مُسنَدَ للرصيد الدائن في الدفتر فينحرف كشف الحساب. المرتجع العابر
      // بلا فاتورة مساره ردٌّ نقديّ فوريّ لا رصيد متجر.
      if (!salesInvoiceNo.trim()) {
        notify.warn(
          "إيداع رصيد المتجر يتطلّب ربط المرتجع بالفاتورة الأصليّة — أدخل رقم الفاتورة، أو اختر استرداداً نقدياً/بالبطاقة للمرتجع العابر",
        );
        return;
      }
    }

    const drawerNotice =
      salesRefundMethod === "CASH"
        ? `استرداد نقدي من درج [${selectedDrawer?.userName || "الكاشير"}]`
        : salesRefundMethod === "CARD"
          ? "استرداد بالبطاقة"
          : "إيداع رصيد متجر بحساب العميل";

    const ok = await confirm({
      title: "تأكيد تنفيذ مرتجع المبيعات",
      description: `سيتم إرجاع ${salesTotalPieces} قطعة بإجمالي ${fmt(String(salesTotal))} د.ع بطريقة [${drawerNotice}]. هل تؤكد التنفيذ الذري فوراً؟`,
      confirmText: "تأكيد وطباعة الإيصال",
      variant: "info",
    });
    if (!ok) return;

    try {
      const res = await salesReturnMutation.mutateAsync({
        invoiceNumber: salesInvoiceNo.trim() || undefined,
        customer: {
          customerId: salesCustomerId ?? undefined,
          name: salesCustomerName.trim() || undefined,
          phone: salesCustomerPhone.trim() || undefined,
        },
        disposition: salesDisposition,
        items: salesCart.map((i) => {
          const factor = Math.max(1, Number(i.conversionFactor) || 1);
          const baseQty = Math.round(i.quantity * factor);
          const totalLineAmount = Number(i.unitPrice) * i.quantity;
          const baseUnitPrice = (totalLineAmount / baseQty).toFixed(2);
          return {
            variantId: i.variantId,
            productUnitId: i.productUnitId,
            invoiceItemId: i.invoiceItemId,
            productName: i.productName,
            barcode: i.barcode,
            quantity: baseQty,
            unitPrice: baseUnitPrice,
          };
        }),
        settlement: {
          method: salesRefundMethod,
          totalAmount: String(salesTotal),
          shiftId:
            salesRefundMethod === "CASH"
              ? (selectedShiftId ?? undefined)
              : undefined,
          reference: salesCardRef.trim() || undefined,
        },
        reason: salesReason.trim() || undefined,
      });

      notify.ok(`تم تنفيذ مرتجع المبيعات بنجاح: ${res.returnNumber}`);

      const printData: PrintSalesReturnData = {
        returnNumber: res.returnNumber,
        originalInvoiceNumber: res.originalInvoiceNumber,
        customerName: res.customerName,
        customerPhone: res.customerPhone,
        disposition: res.disposition,
        method: res.method,
        reference: res.reference,
        totalAmount: res.totalAmount,
        items: res.items,
      };

      void printSalesReturnReceipt(printData);
      onReturnSuccess(printData);
      void openDrawersQ.refetch();

      setSalesCart([]);
      setSalesInvoiceNo("");
      setInspectedInvoice(null);
      setSalesCustomerName("");
      setSalesCustomerPhone("");
      setSalesCustomerId(null);
      setSalesReason("");
      setSalesCardRef("");
      salesBarcodeRef.current?.focus();
    } catch (e: any) {
      notify.err(e.message || "تعذر تنفيذ المرتجع");
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
      {/* العمود الرئيسي: السلة وبيانات العميل */}
      <div className="lg:col-span-8 space-y-3.5">
        {/* بطاقة بيانات الفاتورة والعميل والتصنيف المخزني — تصميم رشيق ومضغوط للأعلى */}
        <Card className="shadow-xs border-emerald-500/20">
          <CardContent className="p-3">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2.5 items-end">
              {/* حقل الفاتورة الأصلية (اختياري) */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold text-foreground">
                    رقم الفاتورة (اختياري)
                  </label>
                  {salesInvoiceNo && (
                    <button
                      type="button"
                      onClick={() => setSalesInvoiceNo("")}
                      className="text-[10px] text-muted-foreground hover:text-destructive"
                    >
                      مسح
                    </button>
                  )}
                </div>
                <div className="flex gap-1">
                  <Input
                    value={salesInvoiceNo}
                    onChange={(e) => setSalesInvoiceNo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleLookupInvoice();
                      }
                    }}
                    placeholder="INV-1002 أو 1002..."
                    className="h-8.5 text-xs"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleLookupInvoice()}
                    disabled={invoiceLookupLoading || !salesInvoiceNo.trim()}
                    className="h-8.5 shrink-0 text-xs px-2.5"
                  >
                    {invoiceLookupLoading ? "فحص..." : "فحص"}
                  </Button>
                </div>
              </div>

              {/* حقل العميل والـ CRM الذكي */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold text-foreground">
                    العميل / CRM (اختياري)
                  </label>
                  {salesCustomerId && (
                    <button
                      type="button"
                      onClick={() => {
                        setSalesCustomerId(null);
                        setSalesCustomerName("");
                        setSalesCustomerPhone("");
                      }}
                      className="text-[10px] text-muted-foreground hover:text-destructive"
                    >
                      إلغاء
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Input
                    value={salesCustomerSearch || salesCustomerName}
                    onChange={(e) => {
                      setSalesCustomerSearch(e.target.value);
                      setSalesCustomerName(e.target.value);
                      if (salesCustomerId) setSalesCustomerId(null);
                    }}
                    placeholder="اسم العميل أو ابحث في الـ CRM..."
                    className="h-8.5 text-xs pr-7"
                  />
                  <UserCheck className="absolute right-2 top-2 size-3.5 text-muted-foreground pointer-events-none" />
                  {debouncedCustomerSearch.length >= 2 &&
                    customersQuery.data &&
                    customersQuery.data.length > 0 &&
                    !salesCustomerId && (
                      <div className="absolute z-30 top-full mt-1 right-0 left-0 bg-popover border rounded-lg shadow-lg p-1 max-h-44 overflow-auto">
                        {customersQuery.data.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setSalesCustomerId(c.id);
                              setSalesCustomerName(c.name);
                              setSalesCustomerPhone(c.phone || "");
                              setSalesCustomerSearch("");
                            }}
                            className="w-full text-right p-1.5 text-xs rounded hover:bg-muted flex items-center justify-between"
                          >
                            <span className="font-semibold">{c.name}</span>
                            <span className="text-muted-foreground font-mono text-[11px]">
                              {c.phone || "—"}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              </div>

              {/* المسار المخزني للصنف: رجوع للرف أو تالف */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-foreground">
                  المسار المخزني للصنف
                </label>
                <div className="grid grid-cols-2 gap-1 bg-muted/40 p-0.5 rounded-lg border">
                  <button
                    type="button"
                    onClick={() => setSalesDisposition("RESTOCK")}
                    className={cn(
                      "h-7 px-2 rounded-md text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer",
                      salesDisposition === "RESTOCK"
                        ? "bg-emerald-600 text-white shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <RotateCcw className="size-3" aria-hidden />
                    <span>رجوع للرف</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setSalesDisposition("DAMAGED")}
                    className={cn(
                      "h-7 px-2 rounded-md text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer",
                      salesDisposition === "DAMAGED"
                        ? "bg-amber-600 text-white shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <AlertTriangle className="size-3" aria-hidden />
                    <span>تالف (خسارة)</span>
                  </button>
                </div>
              </div>

              {/* سبب الإرجاع */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-foreground">
                  سبب الإرجاع / ملاحظة
                </label>
                <Input
                  value={salesReason}
                  onChange={(e) => setSalesReason(e.target.value)}
                  placeholder="رغبة العميل، مقاس، عيب مصنعي..."
                  className="h-8.5 text-xs"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* كارت تفاصيل الفاتورة المفحوصة وسقف الاسترداد وبنودها الأصلية */}
        {inspectedInvoice && (
          <Card
            className={cn(
              "shadow-xs border-2 transition-all",
              inspectedInvoice.isDead
                ? "border-destructive/40 bg-destructive/5"
                : "border-emerald-500/40 bg-emerald-50/20 dark:bg-emerald-950/10",
            )}
          >
            <CardHeader className="p-3 pb-2 flex flex-row items-center justify-between gap-2 border-b">
              <div className="flex items-center gap-2 flex-wrap">
                <FileCheck className="size-4 text-emerald-600" />
                <span className="font-bold text-sm">
                  فاتورة المبيعات #{inspectedInvoice.invoiceNumber}
                </span>
                <Badge
                  variant={inspectedInvoice.isDead ? "destructive" : "outline"}
                  className="text-[10px] font-normal"
                >
                  {inspectedInvoice.status}
                </Badge>
                {inspectedInvoice.customerName && (
                  <span className="text-xs text-muted-foreground font-medium">
                    العميل: {inspectedInvoice.customerName}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {inspectedInvoice.items.some(
                  (i) => i.remainingQuantity > 0,
                ) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddAllRemainingItems}
                    className="h-7 text-xs px-2.5 bg-background text-emerald-700 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-50"
                  >
                    <Plus className="size-3 ml-1" />
                    إرجاع كافة البنود المتبقية
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setInspectedInvoice(null);
                    setSalesInvoiceNo("");
                  }}
                  className="h-7 text-xs text-muted-foreground hover:text-destructive px-2"
                >
                  إلغاء الفحص
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-3 space-y-3">
              {/* المؤشرات المالية للفاتورة */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                <div className="p-2 rounded-lg bg-background border shadow-2xs">
                  <div className="text-[10px] text-muted-foreground">
                    إجمالي الفاتورة
                  </div>
                  <div className="font-bold font-mono text-foreground mt-0.5">
                    {fmt(inspectedInvoice.total)} د.ع
                  </div>
                </div>
                <div className="p-2 rounded-lg bg-background border shadow-2xs">
                  <div className="text-[10px] text-muted-foreground">
                    المدفوع نقداً/بطاقة
                  </div>
                  <div className="font-bold font-mono text-emerald-700 dark:text-emerald-400 mt-0.5">
                    {fmt(inspectedInvoice.paidAmount)} د.ع
                  </div>
                </div>
                <div className="p-2 rounded-lg bg-background border shadow-2xs">
                  <div className="text-[10px] text-muted-foreground">
                    المرتجع سابقاً
                  </div>
                  <div className="font-bold font-mono text-muted-foreground mt-0.5">
                    {fmt(inspectedInvoice.returnedTotal)} د.ع
                  </div>
                </div>
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 shadow-2xs">
                  <div className="text-[10px] text-emerald-800 dark:text-emerald-300 font-bold">
                    سقف الاسترداد المتاح
                  </div>
                  <div className="font-black font-mono text-emerald-700 dark:text-emerald-400 mt-0.5">
                    {fmt(inspectedInvoice.maxRefundable)} د.ع
                  </div>
                </div>
              </div>

              {/* جدول بنود الفاتورة الأصلية ومتاح الإرجاع */}
              {inspectedInvoice.items.length > 0 && (
                <div className="border rounded-lg overflow-hidden shadow-2xs bg-background">
                  <div className="max-h-48 overflow-y-auto">
                    <table className="w-full text-xs text-right">
                      <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10 text-muted-foreground font-semibold border-b">
                        <tr>
                          <th className="p-2">الصنف</th>
                          <th className="p-2 text-center">الكمية المباعة</th>
                          <th className="p-2 text-center">المسترجع</th>
                          <th className="p-2 text-center">المتبقي</th>
                          <th className="p-2">سعر الوحدة</th>
                          <th className="p-2 text-center w-28">إجراء</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {inspectedInvoice.items.map((it) => {
                          const cartItem = salesCart.find(
                            (c) =>
                              c.invoiceItemId === it.invoiceItemId ||
                              (!c.invoiceItemId &&
                                c.variantId === it.variantId),
                          );
                          const inCartQty = cartItem?.quantity || 0;
                          return (
                            <tr
                              key={it.invoiceItemId}
                              className="hover:bg-muted/30"
                            >
                              <td className="p-2 font-medium">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span>{it.productName}</span>
                                  {it.isBundle && (
                                    <Badge
                                      variant="secondary"
                                      className="text-[9px] px-1 py-0 bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-300"
                                    >
                                      بكج مركب
                                    </Badge>
                                  )}
                                  {it.isService && (
                                    <Badge
                                      variant="secondary"
                                      className="text-[9px] px-1 py-0 bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300 border-purple-300"
                                    >
                                      خدمة
                                    </Badge>
                                  )}
                                </div>
                                {it.barcode && (
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    {it.barcode}
                                  </span>
                                )}
                              </td>
                              <td className="p-2 text-center font-mono">
                                {formatQuantity(it.baseQuantity)}
                              </td>
                              <td className="p-2 text-center font-mono text-muted-foreground">
                                {formatQuantity(it.returnedBaseQuantity)}
                              </td>
                              <td className="p-2 text-center font-mono font-bold text-foreground">
                                {formatQuantity(it.remainingQuantity)}
                              </td>
                              <td className="p-2 font-mono">
                                {fmt(it.unitPrice)} د.ع
                              </td>
                              <td className="p-2 text-center">
                                {it.remainingQuantity <= 0 ? (
                                  <span className="text-[10px] text-muted-foreground">
                                    مرتجع بالكامل
                                  </span>
                                ) : (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      handleAddInspectedItemToCart(it)
                                    }
                                    className="h-6 text-[11px] px-2 gap-1 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 hover:bg-emerald-50"
                                  >
                                    <Plus className="size-2.5" />
                                    <span>
                                      {inCartQty > 0
                                        ? `في السلة (${formatQuantity(inCartQty)})`
                                        : "إضافة"}
                                    </span>
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* بطاقة مسح الباركود والبحث الموحد وسلة الأصناف */}
        <Card className="shadow-xs">
          <CardHeader className="p-3 pb-2 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <ShoppingCart className="size-4 text-primary" aria-hidden />
                <span>سلة الأصناف المرتجعة ({salesCart.length})</span>
                {salesTotalPieces > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-[11px] font-normal px-2 py-0"
                  >
                    إجمالي القطع: {salesTotalPieces}
                  </Badge>
                )}
              </CardTitle>
              {salesCart.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSalesCart([])}
                  className="h-7 text-xs text-muted-foreground hover:text-destructive px-2"
                >
                  <Trash2 className="size-3 ml-1" />
                  تفريغ السلة
                </Button>
              )}
            </div>

            {/* المكون الموحد للبحث عن المنتجات وإضافتها للسلة كما في الكاشير */}
            <ProductSearchBar
              invoiceType="SALE_RETURN"
              branchId={activeBranchId}
              tier="RETAIL"
              onAddProduct={handleAddProductFromSearch}
              onNotify={(msg, kind) =>
                kind === "error" ? notify.err(msg) : notify.info(msg)
              }
              placeholder="ابحث بالاسم أو SKU أو امسح الباركود لإضافته للسلة مباشرة... (F2)"
              compact={true}
              autoFocus={true}
            />
          </CardHeader>

          <CardContent className="p-3 pt-0">
            {salesCart.length === 0 ? (
              <div className="py-10 border-2 border-dashed rounded-xl text-center flex flex-col items-center justify-center gap-2 text-muted-foreground bg-muted/10">
                <ShoppingCart className="size-9 text-muted-foreground/40" />
                <p className="font-semibold text-sm">سلة المرتجعات فارغة</p>
                <p className="text-xs max-w-sm">
                  استخدم حقل البحث الموحد أعلاه للبحث اليدوي بالاسم أو مسح
                  الباركود مباشرة لإدراج الأصناف في السلة
                </p>
              </div>
            ) : (
              <div className="border rounded-xl overflow-hidden shadow-2xs">
                <div className="max-h-[460px] overflow-y-auto overflow-x-auto">
                  <table className="w-full text-xs text-right">
                    <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10 text-muted-foreground font-semibold border-b shadow-2xs">
                      <tr>
                        <th className="p-2.5">الصنف</th>
                        <th className="p-2.5 text-center w-36">الكمية</th>
                        <th className="p-2.5 w-36">سعر الإرجاع (د.ع)</th>
                        <th className="p-2.5 w-28 text-left">الإجمالي</th>
                        <th className="p-2.5 w-12 text-center">حذف</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {salesCart.map((item, idx) => {
                        const subtotal =
                          item.quantity * Number(item.unitPrice || 0);
                        const isRecentlyAdded = item.id === lastAddedId;
                        return (
                          <tr
                            key={item.id}
                            className={cn(
                              "transition-colors duration-700",
                              isRecentlyAdded
                                ? "bg-emerald-500/20 dark:bg-emerald-500/25 font-medium"
                                : "hover:bg-muted/20",
                            )}
                          >
                            <td className="p-2.5">
                              <div className="font-bold text-foreground flex items-center gap-1.5 flex-wrap">
                                <span>{item.productName}</span>
                                {item.isBundle && (
                                  <Badge
                                    variant="secondary"
                                    className="text-[9px] px-1 py-0 bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-300"
                                  >
                                    بكج
                                  </Badge>
                                )}
                                {item.unit &&
                                  item.conversionFactor &&
                                  item.conversionFactor > 1 && (
                                    <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">
                                      {item.unit} ({item.conversionFactor} قطعة)
                                    </span>
                                  )}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap mt-0.5">
                                {item.barcode && (
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    {item.barcode}
                                  </span>
                                )}
                                {item.maxAllowedQuantity != null && (
                                  <span className="text-[10px] text-muted-foreground font-mono">
                                    (المتبقي بالفاتورة: {formatQuantity(item.maxAllowedQuantity)})
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="p-2.5">
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSalesCart((prev) =>
                                      prev.map((it, i) =>
                                        i === idx
                                          ? {
                                              ...it,
                                              quantity: Math.max(
                                                1,
                                                it.quantity - 1,
                                              ),
                                            }
                                          : it,
                                      ),
                                    );
                                  }}
                                  className="size-7 rounded border flex items-center justify-center hover:bg-muted text-muted-foreground"
                                >
                                  <Minus className="size-3" />
                                </button>
                                <Input
                                  type="number"
                                  min={1}
                                  max={item.maxAllowedQuantity}
                                  value={item.quantity}
                                  onChange={(e) => {
                                    let q = Math.max(
                                      1,
                                      parseInt(e.target.value, 10) || 1,
                                    );
                                    if (
                                      item.maxAllowedQuantity != null &&
                                      q > item.maxAllowedQuantity
                                    ) {
                                      q = item.maxAllowedQuantity;
                                      notify.warn(
                                        `الحد الأقصى المتاح للإرجاع من الفاتورة هو ${formatQuantity(item.maxAllowedQuantity)}`,
                                      );
                                    }
                                    setSalesCart((prev) =>
                                      prev.map((it, i) =>
                                        i === idx ? { ...it, quantity: q } : it,
                                      ),
                                    );
                                  }}
                                  className="h-7 w-14 text-center text-xs font-bold p-0"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (
                                      item.maxAllowedQuantity != null &&
                                      item.quantity >= item.maxAllowedQuantity
                                    ) {
                                      notify.warn(
                                        `لا يمكن تجاوز الكمية المتبقية في الفاتورة (${formatQuantity(item.maxAllowedQuantity)})`,
                                      );
                                      return;
                                    }
                                    setSalesCart((prev) =>
                                      prev.map((it, i) =>
                                        i === idx
                                          ? { ...it, quantity: it.quantity + 1 }
                                          : it,
                                      ),
                                    );
                                  }}
                                  disabled={
                                    item.maxAllowedQuantity != null &&
                                    item.quantity >= item.maxAllowedQuantity
                                  }
                                  className="size-7 rounded border flex items-center justify-center hover:bg-muted text-muted-foreground disabled:opacity-40"
                                >
                                  <Plus className="size-3" />
                                </button>
                              </div>
                            </td>
                            <td className="p-2.5">
                              <MoneyInput
                                value={item.unitPrice}
                                onChange={(p) => {
                                  if (
                                    item.originalUnitPrice &&
                                    Number(p) > Number(item.originalUnitPrice)
                                  ) {
                                    notify.warn(
                                      `لا يمكن رفع سعر الإرجاع عن سعر البيع في الفاتورة (${fmt(item.originalUnitPrice)} د.ع)`,
                                    );
                                    p = item.originalUnitPrice;
                                  }
                                  setSalesCart((prev) =>
                                    prev.map((it, i) =>
                                      i === idx ? { ...it, unitPrice: p } : it,
                                    ),
                                  );
                                }}
                                className="h-7 text-xs font-mono"
                                ariaLabel="سعر الوحدة"
                              />
                              {item.originalUnitPrice && (
                                <div className="text-[9px] text-muted-foreground font-mono mt-0.5">
                                  سعر الفاتورة: {fmt(item.originalUnitPrice)}
                                </div>
                              )}
                            </td>
                            <td className="p-2.5 text-left font-mono font-bold">
                              {fmt(String(subtotal))}
                            </td>
                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => {
                                  setSalesCart((prev) =>
                                    prev.filter((_, i) => i !== idx),
                                  );
                                }}
                                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                              >
                                <Trash2 className="size-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="p-2.5 bg-muted/30 border-t flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={() => setSalesCart([])}
                    className="text-muted-foreground hover:text-destructive text-[11px]"
                  >
                    تفريغ السلة
                  </button>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      القطع:{" "}
                      <strong className="text-foreground">
                        {salesTotalPieces}
                      </strong>
                    </span>
                    <span>
                      المجموع:{" "}
                      <strong className="text-emerald-700 dark:text-emerald-400 font-mono font-bold text-sm">
                        {fmt(String(salesTotal))} د.ع
                      </strong>
                    </span>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* العمود الجانبي: التسوية المالية والتأكيد الذري */}
      <div className="lg:col-span-4 space-y-5">
        <Card className="shadow-sm border-emerald-500/30">
          <CardHeader className="p-4 pb-2 border-b bg-muted/20">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Wallet className="size-4 text-emerald-600" aria-hidden />
              <span>طريقة الاسترداد المالي والتأكيد</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            {/* كارت المبلغ الإجمالي */}
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-center space-y-1">
              <span className="text-xs text-muted-foreground font-medium">
                إجمالي المبلغ المرتجع للعميل
              </span>
              <div className="text-2xl font-black text-emerald-700 dark:text-emerald-400 font-mono">
                {fmt(String(salesTotal))}{" "}
                <span className="text-sm font-bold">د.ع</span>
              </div>
              <span className="text-[11px] text-muted-foreground">
                إجمالي الأصناف: {salesCart.length} ({salesTotalPieces} قطعة)
              </span>
            </div>

            {/* اختيار طريقة الاسترداد */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-foreground">
                طريقة الاسترداد المالي
              </label>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setSalesRefundMethod("CASH")}
                  className={cn(
                    "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                    salesRefundMethod === "CASH"
                      ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 font-bold text-emerald-900 dark:text-emerald-200"
                      : "border-border hover:bg-muted/50 text-foreground",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <Wallet className="size-4 text-emerald-600" />
                    <div>
                      <div>صرف نقدي كاش (من الصندوق)</div>
                      <div className="text-[10px] text-muted-foreground font-normal">
                        يصرف نقداً ويُسجل كحركة خروج نقد من الدرج
                      </div>
                    </div>
                  </div>
                  {salesRefundMethod === "CASH" && (
                    <CheckCircle2 className="size-4 text-emerald-600" />
                  )}
                </button>

                {salesRefundMethod === "CASH" && (
                  <div className="p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-bold text-emerald-900 dark:text-emerald-300">
                      <span className="flex items-center gap-1.5">
                        <Coins className="size-3.5 text-emerald-600" />
                        اختيار درج النقدية للصرف (الوردية)
                      </span>
                      {openDrawers.length > 0 && (
                        <span className="text-[10px] text-muted-foreground font-normal font-mono">
                          {openDrawers.length} درج متاح
                        </span>
                      )}
                    </div>

                    {openDrawersQ.isLoading ? (
                      <div className="text-[11px] text-muted-foreground p-2 text-center">
                        جارٍ فحص أدراج النقدية المفتوحة...
                      </div>
                    ) : openDrawers.length === 0 ? (
                      <div className="p-2.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 text-[11px] flex items-start gap-2">
                        <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                        <div>
                          <div className="font-bold">
                            لا توجد وردية كاشير مفتوحة حالياً
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            يجب فتح وردية في هذا الفرع لصرف النقد، أو اختيار
                            طريقة استرداد أخرى كالبطاقة أو رصيد المتجر.
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {openDrawers.map((dr) => {
                          const isSelected = dr.shiftId === selectedShiftId;
                          const isLow =
                            Number(dr.expectedCash || 0) < salesTotal;
                          const shiftTypeLabel =
                            dr.shiftType === "RETAIL"
                              ? "تجزئة"
                              : dr.shiftType === "RECEPTION"
                                ? "استقبال"
                                : dr.shiftType === "PRINT_SERVICES"
                                  ? "طباعة"
                                  : dr.shiftType;

                          return (
                            <button
                              key={dr.shiftId}
                              type="button"
                              onClick={() => setSelectedShiftId(dr.shiftId)}
                              className={cn(
                                "w-full p-2 rounded-md border text-right transition-all flex flex-col gap-1 cursor-pointer text-xs",
                                isSelected
                                  ? "border-emerald-600 bg-white dark:bg-card ring-1 ring-emerald-500 font-bold shadow-xs"
                                  : "border-border/70 hover:bg-background/80 bg-background/50 text-foreground",
                              )}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1.5 font-bold">
                                  <span>{dr.userName}</span>
                                  <Badge
                                    variant="outline"
                                    className="text-[9px] py-0 px-1 font-normal"
                                  >
                                    {shiftTypeLabel}
                                  </Badge>
                                  {dr.isMine && (
                                    <Badge className="text-[9px] py-0 px-1 bg-emerald-600 text-white hover:bg-emerald-700 font-normal">
                                      درجي
                                    </Badge>
                                  )}
                                </div>
                                {isSelected && (
                                  <CheckCircle2 className="size-3.5 text-emerald-600" />
                                )}
                              </div>
                              <div className="flex items-center justify-between text-[11px] font-normal">
                                <span className="text-muted-foreground">
                                  النقد بالدرج:
                                </span>
                                <span
                                  className={cn(
                                    "font-mono font-bold",
                                    isLow
                                      ? "text-amber-600 dark:text-amber-400"
                                      : "text-emerald-700 dark:text-emerald-400",
                                  )}
                                >
                                  {fmt(dr.expectedCash)} د.ع
                                </span>
                              </div>
                              {isLow && isSelected && (
                                <div className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                  <AlertCircle className="size-3 shrink-0" />
                                  <span>
                                    تنبيه: النقد بالدرج أقل من مبلغ المرتجع (
                                    {fmt(String(salesTotal))} د.ع)
                                  </span>
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setSalesRefundMethod("CARD")}
                  className={cn(
                    "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                    salesRefundMethod === "CARD"
                      ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 font-bold text-emerald-900 dark:text-emerald-200"
                      : "border-border hover:bg-muted/50 text-foreground",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <CreditCard className="size-4 text-emerald-600" />
                    <div>
                      <div>استرداد بنكي / بطاقة</div>
                      <div className="text-[10px] text-muted-foreground font-normal">
                        إرجاع للبطاقة البنكية مع تسجيل المرجع
                      </div>
                    </div>
                  </div>
                  {salesRefundMethod === "CARD" && (
                    <CheckCircle2 className="size-4 text-emerald-600" />
                  )}
                </button>

                {salesRefundMethod === "CARD" && (
                  <div className="pr-4 pl-1">
                    <Input
                      value={salesCardRef}
                      onChange={(e) => setSalesCardRef(e.target.value)}
                      placeholder="رقم مرجع العملية بالبطاقة (اختياري)..."
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setSalesRefundMethod("STORE_CREDIT")}
                  className={cn(
                    "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                    salesRefundMethod === "STORE_CREDIT"
                      ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 font-bold text-emerald-900 dark:text-emerald-200"
                      : "border-border hover:bg-muted/50 text-foreground",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <Ticket className="size-4 text-emerald-600" />
                    <div>
                      <div>رصيد متجر (Store Credit)</div>
                      <div className="text-[10px] text-muted-foreground font-normal">
                        إيداع رصيد بحساب العميل للمشتريات القادمة
                      </div>
                    </div>
                  </div>
                  {salesRefundMethod === "STORE_CREDIT" && (
                    <CheckCircle2 className="size-4 text-emerald-600" />
                  )}
                </button>
              </div>
            </div>

            {/* سقف الاسترداد المالي للفاتورة إن وجدت */}
            {inspectedInvoice && (
              <div
                className={cn(
                  "p-3 rounded-xl border text-xs space-y-1.5",
                  isOverInvoiceLimit || inspectedInvoice.isDead
                    ? "bg-destructive/10 border-destructive/40 text-destructive"
                    : "bg-emerald-500/10 border-emerald-500/30 text-emerald-950 dark:text-emerald-200",
                )}
              >
                <div className="flex items-center justify-between font-bold">
                  <span className="flex items-center gap-1.5">
                    <FileCheck className="size-3.5 text-emerald-600" />
                    سقف استرداد الفاتورة #{inspectedInvoice.invoiceNumber}
                  </span>
                  <span className="font-mono font-black text-sm">
                    {fmt(inspectedInvoice.maxRefundable)} د.ع
                  </span>
                </div>
                {inspectedInvoice.isDead ? (
                  <div className="text-[11px] font-medium flex items-center gap-1 text-destructive">
                    <AlertCircle className="size-3.5 shrink-0" />
                    <span>
                      الفاتورة مغلقة أو مسترجعة بالكامل ({inspectedInvoice.status}) ولا تقبل مرتجعات
                    </span>
                  </div>
                ) : isOverInvoiceLimit ? (
                  <div className="text-[11px] font-medium flex items-center gap-1 text-destructive">
                    <AlertCircle className="size-3.5 shrink-0" />
                    <span>
                      تجاوز السقف بمقدار (
                      {fmt(
                        String(
                          salesTotal -
                            Number(inspectedInvoice.maxRefundable || 0),
                        ),
                      )}{" "}
                      د.ع) — يرجى تصحيح السلة
                    </span>
                  </div>
                ) : (
                  <div className="text-[10px] text-muted-foreground flex items-center justify-between">
                    <span>المدفوع: {fmt(inspectedInvoice.paidAmount)} د.ع</span>
                    <span>المرتجع: {fmt(inspectedInvoice.returnedTotal)} د.ع</span>
                  </div>
                )}
              </div>
            )}

            {/* زر التنفيذ النهائي */}
            <Button
              type="button"
              onClick={() => void handleExecuteSalesReturn()}
              disabled={
                salesReturnMutation.isPending ||
                salesCart.length === 0 ||
                salesTotal <= 0 ||
                (inspectedInvoice != null &&
                  (inspectedInvoice.isDead || isOverInvoiceLimit))
              }
              className="w-full h-12 text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white gap-2 shadow-sm cursor-pointer disabled:opacity-50"
            >
              <Receipt className="size-5" />
              <span>
                {salesReturnMutation.isPending
                  ? "جاري تنفيذ المرتجع..."
                  : "تأكيد المرتجع وطباعة الإيصال"}
              </span>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
