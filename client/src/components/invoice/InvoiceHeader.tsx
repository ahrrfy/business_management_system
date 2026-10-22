/**
 * InvoiceHeader — top header card with document metadata, entity picker,
 * financial terms and references.
 * Ported from `_design-bundle/project/invoice-header.jsx#InvoiceHeader`.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useRef, useState, type Dispatch } from "react";
import {
  FileText, Hash, Calendar, Building, User, Factory, Tag,
  ClipboardList, Clock, DollarSign, UserCheck, Pin, CalendarDays, NotebookPen, Loader2,
  ChevronDown, ChevronUp,
  type LucideIcon,
} from "lucide-react";
import { EntityPicker } from "./EntityPicker";
import {
  beginPricingSelectionIntent,
  createLatestPricingRequestGuard,
  createPricingIntentEpoch,
  type PricingIntentEpoch,
} from "./productSearchResolution";
import {
  CURRENCIES,
  INVOICE_TYPES,
  PAYMENT_TERMS,
  TIER_OPTIONS,
  type Currency,
  type EntityRow,
  type InvoiceAction,
  type InvoiceState,
  type InvoiceType,
  type PaymentTerm,
  type PriceTier,
  type ResolvedLinePrice,
} from "./types";

export interface InvoiceHeaderProps {
  state: InvoiceState;
  dispatch: Dispatch<InvoiceAction>;
  invoiceType: InvoiceType;
  /** Optional sales reps list (id+name). When empty, the field is hidden. */
  salesReps?: Array<{ id: number; name: string }>;
  /**
   * شارة حالة المستند في رأس المحرّر. الافتراض «مسوّدة» لأنّ كلّ المحرّرات تُنشئ مستنداً جديداً؛
   * شاشةُ تعديلِ مستندٍ قائم تُمرّر حالته الحقيقية (مثل «مؤكّد») كي لا يقرأ المستخدم أنّه يحرّر
   * مسوّدةً بينما هو يعدّل أمراً معتمَداً على وشك الاستلام.
   */
  statusBadge?: string;
  /** ساعة مشتركة مع منتقي المنتجات لإبطال نتائج التسعير القديمة لحظة نية العميل/الفئة. */
  pricingIntentEpoch?: PricingIntentEpoch;
  /**
   * يُثبّت حقل الفرع حتى للأدمن. شاشةُ تعديلِ مستندٍ قائم تحتاجه: فرعُ المستند يحدّد ترقيمه
   * وعزلَه الأمنيّ فلا يُنقَل بتعديل، وتركُ المُنتقي مفتوحاً يجعل الاختيارَ يُهمَل بصمت.
   */
  lockBranch?: boolean;
}

function FieldGroup({
  label,
  icon: Icon,
  required,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon aria-hidden className="size-3 opacity-70" />}
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
    </div>
  );
}

function HeaderSection({
  title,
  icon: Icon,
  children,
  columnsClass,
}: {
  title: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  columnsClass?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider text-primary">
        {Icon && <Icon aria-hidden className="size-3.5" />}
        {title}
        <div className="ms-1 h-px flex-1 bg-border" />
      </div>
      <div className={cn("grid items-end gap-x-2.5 gap-y-1.5", columnsClass ?? "grid-cols-2 md:grid-cols-3 lg:grid-cols-5")}>
        {children}
      </div>
    </div>
  );
}

export function InvoiceHeader({ state, dispatch, invoiceType, salesReps, statusBadge, pricingIntentEpoch, lockBranch }: InvoiceHeaderProps) {
  const typeInfo = INVOICE_TYPES[invoiceType];
  const isSale = invoiceType === "SALE" || invoiceType === "QUOTATION" || invoiceType === "SALE_RETURN";
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  const isQuote = invoiceType === "QUOTATION";
  const isReturn = invoiceType === "SALE_RETURN" || invoiceType === "PURCHASE_RETURN";

  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  // سياسة main الحديثة: الأدمن وحده يعبر الفروع؛ المدير وسائر الأدوار مثبتون على فرع الحساب.
  const canChangeBranch = me.data?.role === "admin" && !lockBranch;
  const utils = trpc.useUtils();
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const pricingRequestGuardRef = useRef(createLatestPricingRequestGuard());
  const localPricingIntentEpochRef = useRef(createPricingIntentEpoch());
  const activePricingIntentEpoch = pricingIntentEpoch ?? localPricingIntentEpochRef.current;
  const [isRepricing, setIsRepricing] = useState(false);

  // رأس تكيّفيّ: يبقى مفتوحاً افتراضياً لئلّا تختفي حقول العميل والفئة والشروط والمندوب فجأةً
  // عند إضافة أوّل صنف، مع إتاحة الطيّ/التوسيع اليدويّ بزرّ الترويسة.
  const [collapsed, setCollapsed] = useState(false);

  const entitySet = state.entityId != null;
  const customerGet = trpc.customers.get.useQuery(
    { customerId: state.entityId ?? 0 },
    { enabled: isSale && state.entityId != null, staleTime: 60_000 },
  );
  const supplierGet = trpc.suppliers.get.useQuery(
    { supplierId: state.entityId ?? 0 },
    { enabled: !isSale && state.entityId != null, staleTime: 60_000 },
  );
  const selectedEntityName = isSale ? customerGet.data?.name : supplierGet.data?.name;
  const branchName = (branches.data ?? []).find((b) => b.id === state.branchId)?.name;
  const tierLabel = TIER_OPTIONS.find((t) => t.value === state.tier)?.label ?? state.tier;
  const paymentLabel = PAYMENT_TERMS.find((t) => t.value === state.paymentTerms)?.label ?? state.paymentTerms;
  const currencyLabel = CURRENCIES.find((c) => c.value === state.currency)?.label ?? state.currency;
  const salesRepName = salesReps?.find((r) => r.id === Number(state.salesRepId))?.name;

  /**
   * Reprice the current cart in one server round-trip when the tier changes.
   * Keep the tier and all line prices atomic so totals never render against a
   * new tier while still carrying the previous tier's prices.
  */
  async function changePriceTier(nextTier: PriceTier) {
    activePricingIntentEpoch.invalidate();
    const intent = beginPricingSelectionIntent(
      pricingRequestGuardRef.current,
      `tier:${nextTier}`,
      latestStateRef.current.tier,
      nextTier,
    );
    if (!intent.changed) {
      setIsRepricing(false);
      return;
    }

    // Returns must retain the source invoice prices. Automatic repricing is
    // intentionally limited to new sales invoices and quotations.
    if (invoiceType !== "SALE" && invoiceType !== "QUOTATION") {
      dispatch({ type: "SET_FIELD", field: "tier", value: nextTier });
      return;
    }

    const requestToken = intent.token;
    const isCurrentRequest = () => pricingRequestGuardRef.current.isCurrent(requestToken, requestToken.context);
    setIsRepricing(true);

    try {
      // A product can be added while the request is in flight. If that happens,
      // repeat with the latest cart before committing the tier atomically.
      for (;;) {
        const snapshot = latestStateRef.current;
        const unitIds = Array.from(new Set(snapshot.items.map((item) => item.productUnitId))).sort((a, b) => a - b);

        if (unitIds.length === 0) {
          dispatch({ type: "SET_FIELD", field: "tier", value: nextTier });
          return;
        }

        const rows = await utils.catalog.byUnitIds.fetch({
          branchId: snapshot.branchId,
          tier: nextTier,
          productUnitIds: unitIds,
          customerId: snapshot.entityId,
        });
        if (!isCurrentRequest()) return;

        const current = latestStateRef.current;
        const currentUnitIds = Array.from(new Set(current.items.map((item) => item.productUnitId))).sort((a, b) => a - b);
        const cartChanged =
          current.branchId !== snapshot.branchId ||
          currentUnitIds.length !== unitIds.length ||
          currentUnitIds.some((id, index) => id !== unitIds[index]);
        if (cartChanged) continue;

        const pricesByUnitId: Record<number, ResolvedLinePrice> = {};
        for (const row of rows) {
          pricesByUnitId[row.productUnitId] = {
            price: row.price ?? "0",
            priceSource: row.isContractPrice ? "CONTRACT" : "TIER",
          };
        }

        dispatch({ type: "SET_TIER_PRICES", tier: nextTier, pricesByUnitId });
        return;
      }
    } catch (error) {
      if (isCurrentRequest()) {
        notify.err(error, "تعذّر تطبيق فئة السعر الجديدة على المنتجات. بقيت الفئة والأسعار السابقة دون تغيير.");
      }
    } finally {
      if (isCurrentRequest()) setIsRepricing(false);
    }
  }

  /** يغيّر العميل وأسعار سلة البيع/العرض معاً كي لا يبقى سعر عميل سابق في مستند العميل الجديد،
   *  ويحوّل فئة السعر تلقائياً لتطابق فئة العميل المختار (أو الافتراضي "RETAIL" عند الإلغاء). */
  async function changeEntity(nextId: number | null, selectedEntity?: EntityRow | null) {
    activePricingIntentEpoch.invalidate();
    const epochToken = activePricingIntentEpoch.capture();

    if (invoiceType !== "SALE" && invoiceType !== "QUOTATION") {
      dispatch({ type: "SET_ENTITY", id: nextId });
      return;
    }

    let targetTier: PriceTier = "RETAIL";
    if (nextId != null) {
      if (selectedEntity?.defaultPriceTier) {
        targetTier = selectedEntity.defaultPriceTier as PriceTier;
      } else {
        try {
          const customer = await utils.customers.get.fetch({ customerId: nextId });
          if (!activePricingIntentEpoch.isCurrent(epochToken)) return;
          if (customer?.defaultPriceTier) {
            targetTier = customer.defaultPriceTier as PriceTier;
          }
        } catch {
          if (!activePricingIntentEpoch.isCurrent(epochToken)) return;
          targetTier = latestStateRef.current.tier;
        }
      }
    } else {
      targetTier = "RETAIL";
    }

    const currentKey = `${latestStateRef.current.entityId ?? "none"}:${latestStateRef.current.tier}`;
    const nextKey = `${nextId ?? "none"}:${targetTier}`;

    const intent = beginPricingSelectionIntent(
      pricingRequestGuardRef.current,
      `customer:${nextId ?? "none"}:tier:${targetTier}`,
      currentKey,
      nextKey,
    );
    if (!intent.changed) {
      setIsRepricing(false);
      return;
    }

    const requestToken = intent.token;
    const isCurrentRequest = () => pricingRequestGuardRef.current.isCurrent(requestToken, requestToken.context);
    setIsRepricing(true);
    try {
      for (;;) {
        const snapshot = latestStateRef.current;
        const unitIds = Array.from(new Set(snapshot.items.map((item) => item.productUnitId)))
          .sort((a, b) => a - b);
        if (unitIds.length === 0) {
          dispatch({ type: "SET_ENTITY", id: nextId, tier: targetTier });
          return;
        }

        const rows = await utils.catalog.byUnitIds.fetch({
          branchId: snapshot.branchId,
          tier: targetTier,
          productUnitIds: unitIds,
          customerId: nextId,
        });
        if (!isCurrentRequest()) return;

        const current = latestStateRef.current;
        const currentUnitIds = Array.from(new Set(current.items.map((item) => item.productUnitId)))
          .sort((a, b) => a - b);
        const cartChanged =
          current.branchId !== snapshot.branchId ||
          current.tier !== snapshot.tier ||
          currentUnitIds.length !== unitIds.length ||
          currentUnitIds.some((id, index) => id !== unitIds[index]);
        if (cartChanged) continue;

        const pricesByUnitId: Record<number, ResolvedLinePrice> = {};
        for (const row of rows) {
          pricesByUnitId[row.productUnitId] = {
            price: row.price ?? "0",
            priceSource: row.isContractPrice ? "CONTRACT" : "TIER",
          };
        }
        dispatch({ type: "SET_ENTITY_PRICES", id: nextId, tier: targetTier, pricesByUnitId });
        return;
      }
    } catch (error) {
      if (isCurrentRequest()) {
        notify.err(error, "تعذّر تطبيق أسعار العميل على المنتجات. بقي العميل والأسعار السابقة دون تغيير.");
      }
    } finally {
      if (isCurrentRequest()) setIsRepricing(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border bg-card shadow-xs">
      {/* Title bar */}
      <header
        className="flex items-center justify-between border-b px-3 py-1.5"
        style={{ background: `linear-gradient(135deg, ${typeInfo.colorHex}0a, transparent)` }}
      >
        <div className="flex items-center gap-1.5">
          <div className={cn("flex h-6 w-6 items-center justify-center rounded-md text-white", typeInfo.colorBg)}>
            <typeInfo.icon aria-hidden className="size-3.5" />
          </div>
          <span className="text-xs font-extrabold text-foreground">{typeInfo.label}</span>
          <span className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--sem-warn)]">
            {statusBadge ?? "مسوّدة"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground" dir="ltr">{state.invoiceNumber}</span>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "توسيع بيانات الفاتورة" : "طيّ بيانات الفاتورة"}
            className="flex size-6 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-accent print:hidden"
          >
            {collapsed ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronUp aria-hidden className="size-3.5" />}
          </button>
        </div>
      </header>

      {/* ملخّص مطويّ — يعرض القيم الفعلية المختارة (اسم العميل/المورد، الفرع، فئة السعر، الشروط، المندوب) */}
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-start print:hidden"
          aria-label="توسيع بيانات الفاتورة للتعديل"
        >
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-bold",
              entitySet
                ? "bg-primary/10 text-primary"
                : isReturn
                  ? "text-muted-foreground"
                  : "border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
            )}
          >
            {isSale ? <User aria-hidden className="size-3" /> : <Factory aria-hidden className="size-3" />}
            {entitySet
              ? `${isSale ? "العميل" : "المورد"}: ${selectedEntityName ?? `#${state.entityId}`}`
              : isReturn
                ? `نقدي — بلا ${isSale ? "عميل" : "مورّد"}`
                : `اختر ${isSale ? "العميل" : "المورد"}`}
          </span>
          {branchName && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-foreground">
              <Building aria-hidden className="size-3 text-muted-foreground" /> {branchName}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" dir="ltr">
            <Calendar aria-hidden className="size-3" /> {state.date}
          </span>
          {isSale && (
            <span className="text-xs font-semibold text-foreground">· {tierLabel}</span>
          )}
          {!isQuote && (
            <span className="text-xs text-muted-foreground">· {paymentLabel}</span>
          )}
          {isPurchase && (
            <span className="text-xs text-muted-foreground">
              · {currencyLabel}
              {state.currency === "USD" && state.agreedRate ? ` (${state.agreedRate})` : ""}
            </span>
          )}
          {salesRepName && (
            <span className="text-xs font-semibold text-foreground">· المندوب: {salesRepName}</span>
          )}
          {isPurchase && state.poReference.trim() && (
            <span className="text-xs text-muted-foreground" dir="ltr">· {state.poReference.trim()}</span>
          )}
          <span className="ms-auto inline-flex items-center gap-1 text-xs font-semibold text-primary">
            تعديل البيانات <ChevronDown aria-hidden className="size-3.5" />
          </span>
        </button>
      )}

      {/* الشبكة الكاملة — تُطوى على الشاشة عند الطيّ اليدوي، لكنها تبقى في DOM وتُطبَع دائماً */}
      <div className={cn("px-3 pb-2.5 pt-2", collapsed && "hidden print:block")}>
        <HeaderSection title="تفاصيل الفاتورة" icon={FileText} columnsClass="grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          <FieldGroup label="رقم المستند" icon={Hash}>
            <Input value={state.invoiceNumber} readOnly className="bg-muted font-bold" />
          </FieldGroup>

          <FieldGroup label="التاريخ" icon={Calendar}>
            <Input
              type="date"
              dir="ltr"
              value={state.date}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "date", value: e.target.value })}
            />
          </FieldGroup>

          <FieldGroup label={canChangeBranch ? "الفرع" : "الفرع المثبّت للحساب"} icon={Building}>
            <Select
              value={String(state.branchId)}
              onValueChange={(v) => dispatch({ type: "SET_FIELD", field: "branchId", value: Number(v) })}
              disabled={!canChangeBranch}
            >
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldGroup>

          {/* المرتجع (بيع/شراء) يُستمَدّ عميله/مورّده من الفاتورة المرجعية عند التحميل، وقد يكون
              نقدياً (بلا عميل) أصلاً — فليس حقلاً إلزامياً هنا كما في فاتورة بيع/شراء جديدة. */}
          <FieldGroup label={isSale ? "العميل" : "المورد"} icon={isSale ? User : Factory} required={!isReturn}>
            <EntityPicker
              type={invoiceType}
              selectedId={state.entityId}
              onSelect={(id, entity) => void changeEntity(id, entity)}
              placeholder={isReturn ? `نقدي — بلا ${isSale ? "عميل" : "مورّد"} (اختياري)` : undefined}
            />
          </FieldGroup>
          {isSale && (
            <FieldGroup label="فئة السعر" icon={Tag}>
              <Select
                value={state.tier}
                disabled={isRepricing}
                onValueChange={(v) => void changePriceTier(v as PriceTier)}
              >
                <SelectTrigger aria-busy={isRepricing}>
                  {isRepricing && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIER_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldGroup>
          )}

          {!isQuote && (
            <FieldGroup label="شروط الدفع" icon={ClipboardList}>
              <Select
                value={state.paymentTerms}
                onValueChange={(v) => dispatch({ type: "SET_FIELD", field: "paymentTerms", value: v as PaymentTerm })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_TERMS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldGroup>
          )}

          {!isQuote && (state.paymentTerms === "CREDIT" || state.paymentTerms === "INSTALLMENT") && (
            <FieldGroup label="تاريخ الاستحقاق" icon={Clock}>
              <Input
                type="date"
                dir="ltr"
                value={state.dueDate}
                onChange={(e) => dispatch({ type: "SET_FIELD", field: "dueDate", value: e.target.value })}
              />
            </FieldGroup>
          )}

          {isPurchase && (
            <FieldGroup label="العملة" icon={DollarSign}>
              <Select
                value={state.currency}
                onValueChange={(v) => dispatch({ type: "SET_FIELD", field: "currency", value: v as Currency })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldGroup>
          )}

          {/* فاتورة شراء USD: أسعار البنود نفسها بالدولار، وهذا سعر التثبيت الذي يحوّلها إلى
              تكلفة مخزون دينارية. إجمالي الدولار يُشتق من البنود ولا يُعاد إدخاله يدوياً. */}
          {isPurchase && state.currency === "USD" && (
            <FieldGroup label="سعر التثبيت (د.ع/$)" icon={DollarSign} required>
              <MoneyInput
                value={state.agreedRate}
                onChange={(v) => dispatch({ type: "SET_FIELD", field: "agreedRate", value: v })}
                decimals={4}
                placeholder="1450"
              />
            </FieldGroup>
          )}

          {isSale && !isReturn && salesReps && salesReps.length > 0 && (
            <FieldGroup label="مندوب المبيعات" icon={UserCheck}>
              <Select
                value={state.salesRepId ? String(state.salesRepId) : "__NONE__"}
                onValueChange={(raw) => {
                  const v = raw === "__NONE__" ? "" : raw;
                  dispatch({ type: "SET_FIELD", field: "salesRepId", value: v ? Number(v) : "" });
                }}
              >
                <SelectTrigger><SelectValue placeholder="— اختياري —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__NONE__">— بلا مندوب —</SelectItem>
                  {salesReps.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldGroup>
          )}

          {isReturn && !isPurchase && (
            <FieldGroup label="رقم الفاتورة المرجعية" icon={Pin} required>
              <Input
                value={state.refInvoice}
                onChange={(e) => dispatch({ type: "SET_FIELD", field: "refInvoice", value: e.target.value })}
                placeholder="INV-2406-XXXX"
              />
            </FieldGroup>
          )}

          {isPurchase && (
            <FieldGroup label="رقم أمر الشراء المرجعي" icon={Pin} required={invoiceType === "PURCHASE_RETURN"}>
              <Input
                value={state.poReference}
                onChange={(e) => dispatch({ type: "SET_FIELD", field: "poReference", value: e.target.value })}
                placeholder="PO-1-20260820-00042"
              />
            </FieldGroup>
          )}

          {isQuote && (
            <FieldGroup label="صالح حتى" icon={CalendarDays}>
              <Input
                type="date"
                dir="ltr"
                value={state.validUntil}
                onChange={(e) => dispatch({ type: "SET_FIELD", field: "validUntil", value: e.target.value })}
              />
            </FieldGroup>
          )}

          <FieldGroup label="ملاحظات" icon={NotebookPen}>
            <Input
              value={state.notes}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "notes", value: e.target.value })}
              placeholder="أضف ملاحظة..."
            />
          </FieldGroup>
        </HeaderSection>
      </div>
    </section>
  );
}
