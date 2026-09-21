/**
 * StorePromotionsManager — إدارة عروض وتخفيضات المتجر الإلكتروني وعتبة التوصيل المجاني.
 *
 * يوفر تحكماً كاملاً لمدير المتجر:
 * 1. عتبة الفواتير للتوصيل المجاني (تعديل مباشر وفوري).
 * 2. قائمة العروض النشطة وغير النشطة مع فلترة وبحث ومؤشرات أداء.
 * 3. إضافة عروض جديدة (نسبة مئوية أو مبلغ ثابت، على المتجر بالكامل أو فئات أو منتجات محددة).
 * 4. تعديل العروض القائمة بالكامل وتحديث أهدافها وتواريخها وقيمها.
 * 5. تعطيل وإعادة تفعيل العروض بنقرة واحدة مع حماية العروض الخاصة بالمتاجر الأخرى أو العامة.
 */
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertCircle,
  Ban,
  Calendar,
  CheckCircle2,
  Clock,
  Layers,
  Loader2,
  Package,
  Pencil,
  Percent,
  Plus,
  Power,
  RotateCcw,
  Save,
  Search,
  Tag,
  Truck,
  X,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { DataTable } from "@/components/data-table/DataTable";
import { formatIqd } from "@/lib/money";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type StorePromotion = RouterOutputs["storeAdmin"]["promotions"]["list"][number];

interface TargetItem {
  kind: "category" | "product";
  id: number;
  label: string;
}

interface PromoFormState {
  id: number | null;
  name: string;
  description: string;
  type: "PERCENT" | "AMOUNT";
  discountPercent: string;
  discountAmount: string;
  scope: "ALL" | "CATEGORIES" | "PRODUCTS";
  effectiveFrom: string;
  effectiveTo: string;
  minLineAmount: string;
  priority: string;
  targets: TargetItem[];
}

function getTodayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const INITIAL_FORM: PromoFormState = {
  id: null,
  name: "",
  description: "",
  type: "PERCENT",
  discountPercent: "10",
  discountAmount: "",
  scope: "ALL",
  effectiveFrom: getTodayYmd(),
  effectiveTo: "",
  minLineAmount: "",
  priority: "0",
  targets: [],
};

export default function StorePromotionsManager() {
  const utils = trpc.useUtils();
  const [includeInactive, setIncludeInactive] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "LIVE" | "INACTIVE">("ALL");

  // بيانات العروض
  const promosQ = trpc.storeAdmin.promotions.list.useQuery({ includeInactive });
  const promotionsList = useMemo(() => promosQ.data ?? [], [promosQ.data]);

  // إعدادات المتجر (عتبات التوصيل المجاني الإقليمية)
  const settingsQ = trpc.storeAdmin.settings.get.useQuery();
  const [thresholdBaghdadInput, setThresholdBaghdadInput] = useState<string | null>(null);
  const [thresholdGovInput, setThresholdGovInput] = useState<string | null>(null);

  // تحديث عتبات التوصيل المجاني
  const updateSettingsM = trpc.storeAdmin.settings.update.useMutation({
    onSuccess: () => {
      notify.ok("تم حفظ عتبات التوصيل المجاني بنجاح");
      setThresholdBaghdadInput(null);
      setThresholdGovInput(null);
      void utils.storeAdmin.settings.get.invalidate();
    },
    onError: (err) => notify.err(err),
  });

  const currentThresholdBaghdad = settingsQ.data?.freeShippingThreshold
    ? String(Number(settingsQ.data.freeShippingThreshold))
    : null;
  const currentThresholdGov = settingsQ.data?.freeShippingThresholdGovernorates
    ? String(Number(settingsQ.data.freeShippingThresholdGovernorates))
    : null;

  const activeThresholdBaghdad =
    thresholdBaghdadInput !== null ? thresholdBaghdadInput : (currentThresholdBaghdad ?? "");
  const activeThresholdGov =
    thresholdGovInput !== null ? thresholdGovInput : (currentThresholdGov ?? "");
  const hasThresholdChanges =
    thresholdBaghdadInput !== null || thresholdGovInput !== null;

  // عمليات العروض
  const createM = trpc.storeAdmin.promotions.create.useMutation({
    onSuccess: () => {
      notify.ok("تم إنشاء العرض بنجاح");
      setShowForm(false);
      void utils.storeAdmin.promotions.list.invalidate();
    },
    onError: (err) => notify.err(err),
  });

  const updateM = trpc.storeAdmin.promotions.update.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث العرض بنجاح");
      setShowForm(false);
      void utils.storeAdmin.promotions.list.invalidate();
    },
    onError: (err) => notify.err(err),
  });

  const deactivateM = trpc.storeAdmin.promotions.deactivate.useMutation({
    onSuccess: () => {
      notify.ok("تم تعطيل العرض");
      void utils.storeAdmin.promotions.list.invalidate();
    },
    onError: (err) => notify.err(err),
  });

  const reactivateM = trpc.storeAdmin.promotions.reactivate.useMutation({
    onSuccess: () => {
      notify.ok("تمت إعادة تفعيل العرض");
      void utils.storeAdmin.promotions.list.invalidate();
    },
    onError: (err) => notify.err(err),
  });

  // نموذج إضافة / تعديل عرض
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<PromoFormState>(INITIAL_FORM);
  const [formError, setFormError] = useState("");

  // منتقي الأهداف
  const [selectedCategoryPick, setSelectedCategoryPick] = useState("");
  const [productSearchInput, setProductSearchInput] = useState("");

  const categoriesQ = trpc.storeAdmin.categories.list.useQuery(undefined, {
    enabled: showForm && form.scope === "CATEGORIES",
  });
  const catalogSearchQ = trpc.storeAdmin.catalog.list.useQuery(
    { q: productSearchInput.trim(), limit: 8 },
    { enabled: showForm && form.scope === "PRODUCTS" && productSearchInput.trim().length >= 2 }
  );

  function openCreateModal() {
    setForm({ ...INITIAL_FORM, effectiveFrom: getTodayYmd() });
    setFormError("");
    setSelectedCategoryPick("");
    setProductSearchInput("");
    setShowForm(true);
  }

  function openEditModal(promo: StorePromotion) {
    const initialTargets: TargetItem[] = (promo.targets ?? []).map((t) => {
      const isCat = t.targetType === "CATEGORY";
      const catName = isCat ? categoriesQ.data?.find((c) => c.id === t.targetId)?.name : undefined;
      return {
        kind: isCat ? "category" : "product",
        id: t.targetId,
        label: catName || (isCat ? `قسم رقم ${t.targetId}` : `منتج رقم ${t.targetId}`),
      };
    });
    setForm({
      id: promo.id,
      name: promo.name,
      description: promo.description ?? "",
      type: promo.type,
      discountPercent: promo.type === "PERCENT" ? String(Number(promo.discountPercent)) : "10",
      discountAmount: promo.type === "AMOUNT" ? String(Number(promo.discountAmount)) : "",
      scope: promo.scope,
      effectiveFrom: promo.effectiveFrom,
      effectiveTo: promo.effectiveTo ?? "",
      minLineAmount: promo.minLineAmount && Number(promo.minLineAmount) > 0 ? String(Number(promo.minLineAmount)) : "",
      priority: String(promo.priority ?? 0),
      targets: initialTargets,
    });
    setFormError("");
    setSelectedCategoryPick("");
    setProductSearchInput("");
    setShowForm(true);
  }

  async function handleToggleActive(promo: StorePromotion) {
    if (!promo.storeOwned) {
      notify.err("هذا العرض عام أو مُدار مركزياً ولا يمكن تعديل حالته من هنا");
      return;
    }

    if (promo.isActive) {
      const ok = await confirm({
        title: "تعطيل العرض؟",
        description: `سيتم إيقاف تطبيق «${promo.name}» فوراً على سلة وطلبات المتجر الإلكتروني.`,
      });
      if (ok) {
        deactivateM.mutate({ promotionId: promo.id });
      }
    } else {
      const ok = await confirm({
        title: "إعادة تفعيل العرض؟",
        description: `سيتم إعادة تفعيل «${promo.name}» وتطبيقه على طلبات المتجر ضمن فترة صلاحيته.`,
      });
      if (ok) {
        reactivateM.mutate({ promotionId: promo.id });
      }
    }
  }

  function handleAddCategoryTarget() {
    if (!selectedCategoryPick) return;
    const catId = Number(selectedCategoryPick);
    const catObj = (categoriesQ.data ?? []).find((c) => c.id === catId);
    if (!catObj) return;
    if (form.targets.some((t) => t.kind === "category" && t.id === catId)) return;
    setForm((prev) => ({
      ...prev,
      targets: [...prev.targets, { kind: "category", id: catId, label: catObj.name }],
    }));
    setSelectedCategoryPick("");
  }

  function handleAddProductTarget(prod: { productId: number; name: string }) {
    if (form.targets.some((t) => t.kind === "product" && t.id === prod.productId)) return;
    setForm((prev) => ({
      ...prev,
      targets: [...prev.targets, { kind: "product", id: prod.productId, label: prod.name }],
    }));
    setProductSearchInput("");
  }

  function handleRemoveTarget(index: number) {
    setForm((prev) => ({
      ...prev,
      targets: prev.targets.filter((_, i) => i !== index),
    }));
  }

  function handleSavePromotion() {
    setFormError("");
    const name = form.name.trim();
    if (!name) {
      setFormError("اسم العرض مطلوب");
      return;
    }
    if (form.type === "PERCENT") {
      const pct = Number(form.discountPercent);
      if (isNaN(pct) || pct <= 0 || pct > 100) {
        setFormError("نسبة الخصم يجب أن تكون أكبر من 0 وأقل من أو تساوي 100");
        return;
      }
    } else {
      const amt = Number(form.discountAmount);
      if (isNaN(amt) || amt <= 0) {
        setFormError("مبلغ الخصم الثابت يجب أن يكون أكبر من صفر");
        return;
      }
    }
    if (!form.effectiveFrom) {
      setFormError("تاريخ بدء العرض مطلوب");
      return;
    }
    if (form.effectiveTo && form.effectiveTo < form.effectiveFrom) {
      setFormError("تاريخ الانتهاء لا يمكن أن يكون قبل تاريخ البدء");
      return;
    }

    if (form.scope !== "ALL" && form.targets.length === 0) {
      setFormError("يرجى اختيار قسم أو منتج واحد على الأقل للعرض المخصص");
      return;
    }

    const targetsPayload = form.scope !== "ALL" && form.targets.length > 0
      ? form.targets.map((t) =>
          t.kind === "category"
            ? { categoryId: t.id, productId: null, variantId: null }
            : { productId: t.id, categoryId: null, variantId: null }
        )
      : undefined;

    if (form.id == null) {
      createM.mutate({
        name,
        description: form.description.trim() || null,
        type: form.type,
        discountPercent: form.type === "PERCENT" ? String(Number(form.discountPercent)) : undefined,
        discountAmount: form.type === "AMOUNT" ? String(Number(form.discountAmount)) : undefined,
        scope: form.scope,
        effectiveFrom: form.effectiveFrom,
        effectiveTo: form.effectiveTo || null,
        minLineAmount: form.minLineAmount ? String(Number(form.minLineAmount)) : undefined,
        priority: Number(form.priority) || 0,
        targets: targetsPayload,
      });
    } else {
      updateM.mutate({
        id: form.id,
        name,
        description: form.description.trim() || null,
        type: form.type,
        discountPercent: form.type === "PERCENT" ? String(Number(form.discountPercent)) : undefined,
        discountAmount: form.type === "AMOUNT" ? String(Number(form.discountAmount)) : undefined,
        scope: form.scope,
        effectiveFrom: form.effectiveFrom,
        effectiveTo: form.effectiveTo || null,
        minLineAmount: form.minLineAmount ? String(Number(form.minLineAmount)) : undefined,
        priority: Number(form.priority) || 0,
        targets: targetsPayload,
      });
    }
  }

  // فلترة قائمة العروض المعروضة
  const filteredPromotions = useMemo(() => {
    return promotionsList.filter((p) => {
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchName = p.name.toLowerCase().includes(q);
        const matchDesc = (p.description ?? "").toLowerCase().includes(q);
        if (!matchName && !matchDesc) return false;
      }
      if (statusFilter === "LIVE" && !p.liveNow) return false;
      if (statusFilter === "INACTIVE" && (p.isActive && p.liveNow)) return false;
      return true;
    });
  }, [promotionsList, searchQuery, statusFilter]);

  // إحصائيات سريعة
  const totalCount = promotionsList.length;
  const liveCount = promotionsList.filter((p) => p.liveNow).length;
  const inactiveCount = promotionsList.filter((p) => !p.isActive).length;

  // تعريف أعمدة DataTable
  const columns = useMemo<ColumnDef<StorePromotion, unknown>[]>(
    () => [
      {
        id: "name",
        header: "العرض",
        accessorFn: (p) => p.name,
        cell: ({ row }) => {
          const promo = row.original;
          const isLive = promo.liveNow;
          return (
            <div className="flex items-start gap-2 py-1">
              <span
                className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md ${
                  isLive ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-muted text-muted-foreground"
                }`}
              >
                <Tag aria-hidden className="size-3.5" />
              </span>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-foreground">{promo.name}</span>
                  {promo.storeOwned ? (
                    <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary text-[10px] px-1.5 py-0">
                      متجر إلكتروني
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-border text-muted-foreground text-[10px] px-1.5 py-0">
                      عرض عام
                    </Badge>
                  )}
                </div>
                {promo.description && (
                  <p className="mt-0.5 max-w-xs truncate text-[11px] text-muted-foreground">
                    {promo.description}
                  </p>
                )}
              </div>
            </div>
          );
        },
      },
      {
        id: "discount",
        header: "قيمة الخصم",
        accessorFn: (p) => (p.type === "PERCENT" ? `${p.discountPercent}%` : p.discountAmount),
        cell: ({ row }) => {
          const promo = row.original;
          const discountDisplay =
            promo.type === "PERCENT"
              ? `${promo.discountPercent}%`
              : formatIqd(Number(promo.discountAmount));
          return (
            <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 font-bold tabular-nums text-primary text-xs">
              {promo.type === "PERCENT" ? <Percent aria-hidden className="size-3" /> : null}
              {discountDisplay}
            </span>
          );
        },
      },
      {
        id: "scope",
        header: "نطاق التطبيق",
        accessorFn: (p) => p.scope,
        cell: ({ row }) => {
          const promo = row.original;
          return (
            <div className="text-xs">
              {promo.scope === "ALL" && <span className="text-muted-foreground">كامل منتجات المتجر</span>}
              {promo.scope === "CATEGORIES" && (
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <Layers aria-hidden className="size-3.5 text-muted-foreground" />
                  فئات محددة ({promo.targetCount})
                </span>
              )}
              {promo.scope === "PRODUCTS" && (
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <Package aria-hidden className="size-3.5 text-muted-foreground" />
                  منتجات محددة ({promo.targetCount})
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: "validity",
        header: "فترة الصلاحية",
        accessorFn: (p) => `${p.effectiveFrom} — ${p.effectiveTo ?? ""}`,
        cell: ({ row }) => {
          const promo = row.original;
          return (
            <div className="flex flex-col text-[11px] tabular-nums text-muted-foreground">
              <span className="flex items-center gap-1">
                <Calendar aria-hidden className="size-3" /> من: {promo.effectiveFrom}
              </span>
              {promo.effectiveTo ? (
                <span>إلى: {promo.effectiveTo}</span>
              ) : (
                <span className="text-muted-foreground/70">مفتوح بلا نهاية</span>
              )}
            </div>
          );
        },
      },
      {
        id: "rules",
        header: "الحد والأولوية",
        cell: ({ row }) => {
          const promo = row.original;
          return (
            <div className="flex flex-col text-[11px]">
              {Number(promo.minLineAmount) > 0 ? (
                <span className="tabular-nums text-muted-foreground">
                  حد أدنى: {formatIqd(Number(promo.minLineAmount))}
                </span>
              ) : (
                <span className="text-muted-foreground/60">بلا حد أدنى</span>
              )}
              <span className="text-[10px] text-muted-foreground">الأولوية: {promo.priority}</span>
            </div>
          );
        },
      },
      {
        id: "status",
        header: "الحالة",
        cell: ({ row }) => {
          const promo = row.original;
          if (!promo.isActive) {
            return (
              <Badge variant="outline" className="border-border bg-muted/50 text-muted-foreground text-[10px]">
                معطّل
              </Badge>
            );
          }
          if (promo.liveNow) {
            return (
              <Badge variant="outline" className="border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] text-[10px]">
                سارٍ الآن
              </Badge>
            );
          }
          return (
            <Badge variant="outline" className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] text-[10px]">
              خارج النافذة
            </Badge>
          );
        },
      },
      {
        id: "actions",
        header: "الإجراءات",
        meta: { kind: "actions" },
        cell: ({ row }) => {
          const promo = row.original;
          return (
            <div className="flex items-center justify-center gap-1">
              {promo.storeOwned && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEditModal(promo)}
                  className="size-8 p-0 text-muted-foreground hover:text-foreground"
                  title="تعديل العرض"
                >
                  <Pencil aria-hidden className="size-4" />
                </Button>
              )}

              {promo.storeOwned && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggleActive(promo)}
                  disabled={deactivateM.isPending || reactivateM.isPending}
                  className={`size-8 p-0 ${
                    promo.isActive
                      ? "text-[var(--sem-neg)] hover:bg-[var(--sem-neg-bg)]"
                      : "text-[var(--sem-pos)] hover:bg-[var(--sem-pos-bg)]"
                  }`}
                  title={promo.isActive ? "تعطيل العرض" : "إعادة تفعيل العرض"}
                >
                  {promo.isActive ? (
                    <Power aria-hidden className="size-4" />
                  ) : (
                    <RotateCcw aria-hidden className="size-4" />
                  )}
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deactivateM.isPending, reactivateM.isPending]
  );

  return (
    <div className="space-y-6">
      {/* بطاقة عتبة التوصيل المجاني */}
      <Card className="border-primary/20 bg-gradient-to-l from-primary/5 via-card to-card">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Truck aria-hidden className="size-5" />
              </span>
              <div>
                <CardTitle className="text-base font-bold">عتبات التوصيل المجاني للطلبات الإلكترونية</CardTitle>
                <p className="text-xs text-muted-foreground">
                  تحكم كامل ومستقل في حد الفاتورة الذي يعفي الطلب من أجور الشحن داخل بغداد ولكافة المحافظات.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {currentThresholdBaghdad ? (
                <Badge variant="outline" className="border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] text-xs font-semibold">
                  <CheckCircle2 aria-hidden className="mr-1 size-3.5" />
                  بغداد: فوق {formatIqd(Number(currentThresholdBaghdad))}
                </Badge>
              ) : (
                <Badge variant="outline" className="border-border text-muted-foreground text-xs">
                  بغداد: معطّل
                </Badge>
              )}
              {currentThresholdGov ? (
                <Badge variant="outline" className="border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] text-xs font-semibold">
                  <CheckCircle2 aria-hidden className="mr-1 size-3.5" />
                  المحافظات: فوق {formatIqd(Number(currentThresholdGov))}
                </Badge>
              ) : (
                <Badge variant="outline" className="border-border text-muted-foreground text-xs">
                  المحافظات: معطّل
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  عتبة الشحن المجاني (داخل بغداد):
                </label>
                <MoneyInput
                  value={activeThresholdBaghdad}
                  onChange={(val) => setThresholdBaghdadInput(val)}
                  decimals={0}
                  placeholder="مثال: 35,000 (فارغ للتعطيل)"
                  ariaLabel="حد الشحن المجاني داخل بغداد"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  يشمل بغداد المركز والعامرية وكافة أحياء العاصمة.
                </span>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  عتبة الشحن المجاني (كافة المحافظات):
                </label>
                <MoneyInput
                  value={activeThresholdGov}
                  onChange={(val) => setThresholdGovInput(val)}
                  decimals={0}
                  placeholder="مثال: 60,000 (فارغ للتعطيل)"
                  ariaLabel="حد الشحن المجاني لكافة المحافظات"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  يطبق على باقي المحافظات (البصرة، نينوى، أربيل، كركوك...).
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button
                onClick={() =>
                  updateSettingsM.mutate({
                    freeShippingThreshold: activeThresholdBaghdad ? String(Number(activeThresholdBaghdad)) : null,
                    freeShippingThresholdGovernorates: activeThresholdGov ? String(Number(activeThresholdGov)) : null,
                  })
                }
                disabled={updateSettingsM.isPending}
                className="gap-1.5"
              >
                {updateSettingsM.isPending ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : (
                  <Save aria-hidden className="size-4" />
                )}
                حفظ عتبات التوصيل المجاني
              </Button>
              {hasThresholdChanges && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setThresholdBaghdadInput(null);
                    setThresholdGovInput(null);
                  }}
                  className="text-xs text-muted-foreground"
                >
                  إلغاء التغيير
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* شريط الإحصائيات */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground">إجمالي العروض</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{totalCount}</p>
            </div>
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Tag aria-hidden className="size-5" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground">العروض السارية الآن</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--sem-pos)]">{liveCount}</p>
            </div>
            <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]">
              <CheckCircle2 aria-hidden className="size-5" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground">عروض غير نشطة / معطلة</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-muted-foreground">{inactiveCount}</p>
            </div>
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Ban aria-hidden className="size-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* أدوات البحث والفلترة مع زر الإضافة وجدول DataTable */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-64">
              <Search aria-hidden className="absolute right-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث في اسم أو وصف العرض..."
                className="pr-9 text-xs"
              />
            </div>

            <div className="flex rounded-lg bg-muted p-1 text-xs">
              <button
                onClick={() => setStatusFilter("ALL")}
                className={`rounded-md px-2.5 py-1 transition ${
                  statusFilter === "ALL" ? "bg-primary font-bold text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                الكل ({totalCount})
              </button>
              <button
                onClick={() => setStatusFilter("LIVE")}
                className={`rounded-md px-2.5 py-1 transition ${
                  statusFilter === "LIVE" ? "bg-primary font-bold text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                سارٍ الآن ({liveCount})
              </button>
              <button
                onClick={() => setStatusFilter("INACTIVE")}
                className={`rounded-md px-2.5 py-1 transition ${
                  statusFilter === "INACTIVE" ? "bg-primary font-bold text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                معطل ({inactiveCount})
              </button>
            </div>

            <label className="flex items-center gap-1.5 text-xs text-muted-foreground mr-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="rounded border-border"
              />
              إظهار العروض المعطلة
            </label>
          </div>

          <Button onClick={openCreateModal} className="gap-1.5 font-bold">
            <Plus aria-hidden className="size-4" />
            إضافة عرض جديد
          </Button>
        </CardHeader>

        <CardContent>
          <DataTable<StorePromotion>
            columns={columns}
            data={filteredPromotions}
            searchable={false}
            externalFiltersActive={searchQuery.trim() !== "" || statusFilter !== "ALL"}
            loading={promosQ.isLoading}
            errorState={{
              isError: promosQ.isError,
              message: promosQ.error?.message,
              onRetry: () => void promosQ.refetch(),
            }}
            emptyText="لا توجد عروض مطابقة للفلاتر."
          />
        </CardContent>
      </Card>

      {/* نافذة إضافة / تعديل العرض */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-bold">
              <Tag aria-hidden className="size-5 text-primary" />
              {form.id == null ? "إضافة عرض ترويجي جديد للمتجر" : "تعديل عرض المتجر"}
            </DialogTitle>
          </DialogHeader>

          {formError && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] p-3 text-xs text-[var(--sem-neg)]">
              <AlertCircle aria-hidden className="size-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="space-y-4 py-2 text-xs">
            {/* اسم العرض */}
            <div>
              <label className="mb-1 block font-medium text-muted-foreground">اسم العرض الترويجي *</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="مثال: خصم موسم العودة للمدارس"
                className="text-xs"
              />
            </div>

            {/* الوصف */}
            <div>
              <label className="mb-1 block font-medium text-muted-foreground">الوصف الترويجي (اختياري)</label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="تفاصيل تظهر لزبائن المتجر أو توضيحات داخلية..."
                rows={2}
                className="text-xs"
              />
            </div>

            {/* نوع وقيمة الخصم */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-medium text-muted-foreground">نوع الخصم</label>
                <AppSelect
                  value={form.type}
                  onValueChange={(val) => setForm({ ...form, type: val as "PERCENT" | "AMOUNT" })}
                  aria-label="نوع الخصم"
                >
                  <option value="PERCENT">نسبة مئوية (%)</option>
                  <option value="AMOUNT">مبلغ ثابت بالدينار (د.ع)</option>
                </AppSelect>
              </div>

              <div>
                <label className="mb-1 block font-medium text-muted-foreground">
                  {form.type === "PERCENT" ? "نسبة الخصم (%) *" : "مبلغ الخصم الثابت بالدينار *"}
                </label>
                {form.type === "PERCENT" ? (
                  <Input
                    type="number"
                    min="1"
                    max="100"
                    value={form.discountPercent}
                    onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                    placeholder="مثال: 15"
                    className="text-xs"
                  />
                ) : (
                  <MoneyInput
                    value={form.discountAmount}
                    onChange={(val) => setForm({ ...form, discountAmount: val })}
                    decimals={0}
                    placeholder="مثال: 5,000"
                    ariaLabel="مبلغ الخصم الثابت"
                  />
                )}
              </div>
            </div>

            {/* نطاق التطبيق */}
            <div>
              <label className="mb-1 block font-medium text-muted-foreground">نطاق تطبيق العرض</label>
              <AppSelect
                value={form.scope}
                onValueChange={(val) =>
                  setForm({ ...form, scope: val as "ALL" | "CATEGORIES" | "PRODUCTS", targets: [] })
                }
                aria-label="نطاق التطبيق"
              >
                <option value="ALL">جميع منتجات المتجر الإلكتروني</option>
                <option value="CATEGORIES">أقسام / فئات محددة فقط</option>
                <option value="PRODUCTS">منتجات محددة بالاسم فقط</option>
              </AppSelect>
            </div>

            {/* منتقي الأهداف للفئات */}
            {form.scope === "CATEGORIES" && (
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                <span className="block font-semibold text-foreground">حدد الأقسام المشمولة بالعرض:</span>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <AppSelect
                      value={selectedCategoryPick}
                      onValueChange={(val) => setSelectedCategoryPick(val)}
                      aria-label="اختر قسماً لإضافته"
                    >
                      <option value="">اختر قسماً لإضافته...</option>
                      {(categoriesQ.data ?? []).map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))}
                    </AppSelect>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddCategoryTarget}
                    disabled={!selectedCategoryPick}
                    className="gap-1 text-xs"
                  >
                    <Plus aria-hidden className="size-3.5" /> إضافة القسم
                  </Button>
                </div>

                {form.targets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-2">
                    {form.targets.map((t, idx) => (
                      <span
                        key={t.id}
                        className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary"
                      >
                        <Layers aria-hidden className="size-3" />
                        {t.label}
                        <button
                          type="button"
                          onClick={() => handleRemoveTarget(idx)}
                          className="hover:text-destructive"
                        >
                          <X aria-hidden className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* منتقي الأهداف للمنتجات */}
            {form.scope === "PRODUCTS" && (
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                <span className="block font-semibold text-foreground">ابحث واختر المنتجات المشمولة:</span>
                <div className="relative">
                  <Search aria-hidden className="absolute right-3 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    value={productSearchInput}
                    onChange={(e) => setProductSearchInput(e.target.value)}
                    placeholder="اكتب حرفين أو أكثر للبحث في الكتالوج..."
                    className="pr-9 text-xs"
                  />
                </div>

                {catalogSearchQ.data && catalogSearchQ.data.rows.length > 0 && (
                  <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-card p-1">
                    {catalogSearchQ.data.rows.map((prod) => (
                      <button
                        key={prod.productId}
                        type="button"
                        onClick={() => handleAddProductTarget({ productId: prod.productId, name: prod.name })}
                        className="flex w-full items-center justify-between rounded px-2 py-1 text-right text-xs hover:bg-muted"
                      >
                        <span className="font-medium">{prod.name}</span>
                        <span className="text-[10px] text-muted-foreground">{prod.categoryName ?? "بلا قسم"}</span>
                      </button>
                    ))}
                  </div>
                )}

                {form.targets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-2">
                    {form.targets.map((t, idx) => (
                      <span
                        key={t.id}
                        className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary"
                      >
                        <Package aria-hidden className="size-3" />
                        {t.label}
                        <button
                          type="button"
                          onClick={() => handleRemoveTarget(idx)}
                          className="hover:text-destructive"
                        >
                          <X aria-hidden className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* تواريخ الصلاحية */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-medium text-muted-foreground">تاريخ البدء *</label>
                <Input
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
                  className="text-xs"
                />
              </div>

              <div>
                <label className="mb-1 block font-medium text-muted-foreground">تاريخ الانتهاء (اختياري)</label>
                <Input
                  type="date"
                  value={form.effectiveTo}
                  onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })}
                  className="text-xs"
                />
              </div>
            </div>

            {/* الحد الأدنى للسطر والأولوية */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-medium text-muted-foreground">
                  حد أدنى لقيمة السطر (د.ع - اختياري)
                </label>
                <MoneyInput
                  value={form.minLineAmount}
                  onChange={(val) => setForm({ ...form, minLineAmount: val })}
                  decimals={0}
                  placeholder="مثال: 10,000"
                  ariaLabel="الحد الأدنى لقيمة السطر"
                />
              </div>

              <div>
                <label className="mb-1 block font-medium text-muted-foreground">الأولوية (الأعلى يُطبَّق أولاً)</label>
                <Input
                  type="number"
                  min="0"
                  max="999"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  placeholder="0"
                  className="text-xs"
                />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowForm(false)}
              className="text-xs"
            >
              إلغاء
            </Button>
            <Button
              type="button"
              onClick={handleSavePromotion}
              disabled={createM.isPending || updateM.isPending}
              className="gap-1 text-xs font-bold"
            >
              {createM.isPending || updateM.isPending ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : (
                <Save aria-hidden className="size-4" />
              )}
              {form.id == null ? "حفظ العرض الجديد" : "تحديث العرض"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
