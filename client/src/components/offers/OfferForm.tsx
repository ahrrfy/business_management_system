/**
 * client/src/components/offers/OfferForm.tsx
 *
 * Master 4-step wizard form for Offers and Promotions:
 * Step 1: Basic Info (label="اسم العرض", description, campaign, priority, applicationMode)
 * Step 2: Type & Value (label="نوع الخصم": single or multi-rule 6 promo types)
 * Step 3: Scope & Targets (label="النطاق": shared or per-rule scope, bulk-add suite, scanner & live table)
 * Step 4: Scheduling & Channels (label="قناة العرض", branch, delivery perks, label="من تاريخ", simulator)
 */

import React, { useEffect, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Check, Copy, Loader2, Save, X } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Field } from "@/components/product/variantBits";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc } from "@/lib/trpc";
import { OfferBulkAddToolbar } from "./OfferBulkAddToolbar";
import { OfferChannelStepSection, type ShippingPerkMode } from "./OfferChannelStepSection";
import { OfferLivePreviewSimulator } from "./OfferLivePreviewSimulator";
import { OfferMultiRuleBar } from "./OfferMultiRuleBar";
import { OfferProductSearchInput } from "./OfferProductSearchInput";
import { OfferRuleValueFields } from "./OfferRuleValueFields";
import { OfferSelectedItemsTable } from "./OfferSelectedItemsTable";
import { OfferTypeCards } from "./OfferTypeCards";
import {
  addDaysYmd,
  buildTargetsForHolder,
  createDefaultRuleDraft,
  endOfMonthYmd,
  posDec,
  sanitizeRuleTiers,
  summarizeRuleDraft,
  validateRuleScopeAndMargin,
  validateRuleTypeFields,
} from "./offersMultiRuleHelpers";
import {
  ACTIVE_DAYS_LIST,
  APPLICATION_LABELS,
  CHANNEL_LABELS,
  CUSTOMER_TIER_LABELS,
  PROMO_TYPE_LABELS,
  toYmd,
  todayYmd,
  type ApplicationMode,
  type CustomerTier,
  type OfferFormData,
  type OfferRuleDraft,
  type PromoChannel,
  type PromoScope,
  type PromoType,
  type ScopeSharingMode,
  type SelectedOfferItem,
} from "./offersTypes";

export interface OfferFormProps {
  editingId: number | null;
  onSuccess: () => void | Promise<void>;
  onDuplicated?: (newPromotionId: number) => void | Promise<void>;
  onCancel: () => void;
}

export function OfferForm({ editingId, onSuccess, onDuplicated, onCancel }: OfferFormProps) {
  const utils = trpc.useUtils();
  const meQ = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const campaignsQ = trpc.crm.campaigns.list.useQuery();
  const categoriesQ = trpc.catalog.categories.useQuery();
  const isAdmin = meQ.data?.role === "admin";

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Basic Info
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [priority, setPriority] = useState("0");
  const [applicationMode, setApplicationMode] = useState<ApplicationMode>("AUTO");

  // Step 2 & 3: Rules (supports 1 or multiple rules in creation mode)
  const [rules, setRules] = useState<OfferRuleDraft[]>(() => [
    createDefaultRuleDraft("PERCENT", "rule_primary"),
  ]);
  const [activeRuleIdx, setActiveRuleIdx] = useState(0);
  const [scopeSharingMode, setScopeSharingMode] = useState<ScopeSharingMode>("SHARED");
  const [scopeRuleIdx, setScopeRuleIdx] = useState(0);

  // Step 4: Channels, Branch, Shipping, Dates & Eligibility
  const [channel, setChannel] = useState<PromoChannel>("ALL");
  const [branchId, setBranchId] = useState("");
  const [shippingPerkMode, setShippingPerkMode] = useState<ShippingPerkMode>("NONE");
  const [shippingDiscountAmount, setShippingDiscountAmount] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayYmd());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [customerTier, setCustomerTier] = useState<CustomerTier>("");
  const [minOrderSpend, setMinOrderSpend] = useState("");
  const [activeDays, setActiveDays] = useState<number[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [wasInitiallyInactive, setWasInitiallyInactive] = useState(false);

  const getByIdQ = trpc.salesPromotions.getById.useQuery(
    { promotionId: editingId! },
    { enabled: editingId != null, staleTime: 0 }
  );
  const isHydratingEdit = editingId != null && getByIdQ.isLoading;

  useEffect(() => {
    if (!getByIdQ.data) return;
    const { promotion, targets, hydratedTargets, tiers: dbTiers } = getByIdQ.data;

    setName(promotion.name ?? "");
    setDescription(promotion.description ?? "");
    setCampaignId(promotion.campaignId ? String(promotion.campaignId) : "");
    setPriority(String(promotion.priority ?? 0));
    setApplicationMode((promotion.applicationMode as ApplicationMode) ?? "AUTO");

    const activeFlag = Boolean(promotion.isActive);
    setIsActive(activeFlag);
    setWasInitiallyInactive(!activeFlag);

    const hydratedProducts: SelectedOfferItem[] = (hydratedTargets ?? []).map((ht) => ({
      targetGrain: ht.targetGrain,
      productId: ht.productId,
      productName: ht.productName,
      productCode: ht.productCode,
      variantId: ht.variantId,
      sku: ht.sku,
      variantKind: ht.variantKind,
      isConsignment: ht.isConsignment,
      costPrice: ht.costPrice,
      productUnitId: ht.productUnitId,
      unitName: ht.unitName,
      conversionFactor: ht.conversionFactor,
      retailPrice: ht.retailPrice,
      barcode: ht.barcode,
      isBaseUnit: ht.isBaseUnit,
      units: ht.units,
    }));

    setRules([
      {
        key: "rule_primary",
        ruleLabel: "",
        type: promotion.type,
        discountPercent: promotion.discountPercent ? String(promotion.discountPercent) : "10",
        discountAmount:
          promotion.discountAmount && Number(promotion.discountAmount) > 0
            ? String(promotion.discountAmount)
            : "",
        maxDiscountAmount: promotion.maxDiscountAmount ? String(promotion.maxDiscountAmount) : "",
        fixedPrice: promotion.fixedPrice ? String(promotion.fixedPrice) : "",
        bundlePrice: promotion.bundlePrice ? String(promotion.bundlePrice) : "",
        bundleMode: (promotion.bundleMode as any) ?? "ALL_REQUIRED",
        bundleQuantity: promotion.bundleQuantity ?? 2,
        bogoBuyQuantity: promotion.bogoBuyQuantity ?? 2,
        bogoGetQuantity: promotion.bogoGetQuantity ?? 1,
        bogoGetDiscountPercent: promotion.bogoGetDiscountPercent
          ? String(promotion.bogoGetDiscountPercent)
          : "100",
        tieredMode: (promotion.tieredMode as any) ?? "PER_ITEM",
        tiers: (dbTiers ?? []).map((t) => ({
          id: t.id,
          minQuantity: t.minQuantity,
          tierType: t.tierType,
          discountPercent: t.tierType === "PERCENT" ? t.discountPercent : undefined,
          discountAmount: t.tierType === "AMOUNT" ? t.discountAmount : undefined,
          fixedPrice: t.tierType === "FIXED_PRICE" ? (t.fixedPrice ?? "") : undefined,
        })),
        scope: promotion.scope,
        selectedCategories: (targets ?? [])
          .filter((t) => t.categoryId != null)
          .map((t) => t.categoryId!),
        selectedProducts: hydratedProducts,
        allowBelowCost: Boolean(promotion.allowBelowCost),
        applyToBaseUnitOnly: promotion.applyToBaseUnitOnly ?? true,
        minLineAmount:
          promotion.minLineAmount && Number(promotion.minLineAmount) > 0
            ? String(promotion.minLineAmount)
            : "",
      },
    ]);
    setActiveRuleIdx(0);
    setScopeRuleIdx(0);
    setScopeSharingMode("SHARED");

    setChannel((promotion.channel as PromoChannel) ?? "ALL");
    setBranchId(promotion.branchId != null ? String(promotion.branchId) : "");
    if (promotion.freeShipping || promotion.type === "FREE_SHIPPING") {
      setShippingPerkMode("FREE");
      setShippingDiscountAmount("");
    } else if (promotion.shippingDiscountAmount && Number(promotion.shippingDiscountAmount) > 0) {
      setShippingPerkMode("DISCOUNT");
      setShippingDiscountAmount(String(promotion.shippingDiscountAmount));
    } else {
      setShippingPerkMode("NONE");
      setShippingDiscountAmount("");
    }
    setEffectiveFrom(toYmd(promotion.effectiveFrom) || todayYmd());
    setEffectiveTo(promotion.effectiveTo ? toYmd(promotion.effectiveTo) : "");
    setCustomerTier((promotion.customerTier ?? "") as CustomerTier);
    setMinOrderSpend(
      promotion.minOrderSpend && Number(promotion.minOrderSpend) > 0
        ? String(promotion.minOrderSpend)
        : ""
    );
    setActiveDays(promotion.activeDays ?? []);
  }, [getByIdQ.data]);

  const activeRule = rules[activeRuleIdx] ?? rules[0]!;
  const updateRuleAt = (idx: number, updater: (prev: OfferRuleDraft) => OfferRuleDraft) => {
    setRules((prev) => prev.map((r, i) => (i === idx ? updater(r) : r)));
  };
  const updateActiveRule = (patch: Partial<OfferRuleDraft>) => {
    updateRuleAt(activeRuleIdx, (r) => ({ ...r, ...patch }));
  };

  const currentScopeIdx =
    scopeSharingMode === "PER_RULE" && rules.length > 1
      ? Math.min(scopeRuleIdx, rules.length - 1)
      : 0;
  const targetScopeRule = rules[currentScopeIdx] ?? rules[0]!;
  const updateScopeRule = (updater: (prev: OfferRuleDraft) => OfferRuleDraft) => {
    updateRuleAt(currentScopeIdx, updater);
  };

  const handleAddRuleWithType = (newType: PromoType = "FIXED_PRICE") => {
    const base = rules[0]!;
    const draft = createDefaultRuleDraft(newType);
    draft.scope = base.scope;
    draft.allowBelowCost = base.allowBelowCost;
    draft.applyToBaseUnitOnly = base.applyToBaseUnitOnly;
    setRules((prev) => {
      const next = [...prev, draft];
      setActiveRuleIdx(next.length - 1);
      return next;
    });
  };

  const handleRemoveRule = (idx: number) => {
    if (rules.length <= 1) return;
    setRules((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      setActiveRuleIdx((cur) => Math.min(cur, next.length - 1));
      setScopeRuleIdx((cur) => Math.min(cur, next.length - 1));
      return next;
    });
  };

  const createM = trpc.salesPromotions.create.useMutation({
    onSuccess: async () => {
      await utils.salesPromotions.list.invalidate();
      await onSuccess();
    },
    onError: (e) => setError(e.message),
  });

  const updateM = trpc.salesPromotions.update.useMutation({
    onSuccess: async () => {
      await utils.salesPromotions.list.invalidate();
      await onSuccess();
    },
    onError: (e) => setError(e.message),
  });

  const duplicateM = trpc.salesPromotions.duplicate.useMutation({
    onSuccess: async (res) => {
      await utils.salesPromotions.list.invalidate();
      if (onDuplicated) await onDuplicated(res.promotionId);
      else await onSuccess();
    },
    onError: (e) => setError(e.message),
  });

  const validateStep = (s: number): string | null => {
    if (s === 1 && !name.trim()) return "اسم العرض مطلوب ولا يمكن أن يكون فارغاً.";
    if (s === 2) {
      for (let i = 0; i < rules.length; i++) {
        const prefix = rules.length > 1 ? `القاعدة ${i + 1}: ` : "";
        const err = validateRuleTypeFields(rules[i]!, prefix);
        if (err) {
          setActiveRuleIdx(i);
          return err;
        }
      }
    }
    if (s === 3) {
      for (let i = 0; i < rules.length; i++) {
        const prefix = rules.length > 1 ? `القاعدة ${i + 1}: ` : "";
        const holder = scopeSharingMode === "PER_RULE" && rules.length > 1 ? rules[i]! : rules[0]!;
        const err = validateRuleScopeAndMargin(rules[i]!, holder, prefix);
        if (err) {
          if (scopeSharingMode === "PER_RULE" && rules.length > 1) setScopeRuleIdx(i);
          return err;
        }
      }
    }
    if (s === 4) {
      if (!effectiveFrom) return "تاريخ البدء مطلوب.";
      if (effectiveTo && effectiveTo < effectiveFrom) return "تاريخ الانتهاء أقدم من تاريخ البدء.";
      if (shippingPerkMode === "DISCOUNT" && !posDec(shippingDiscountAmount)) {
        return "أدخل مبلغ خصم التوصيل أكبر من صفر أو اختر بدون خصم توصيل.";
      }
    }
    return null;
  };

  const nextStep = () => {
    const err = validateStep(step);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStep((prev) => Math.min(4, prev + 1) as any);
  };

  const prevStep = () => {
    setError(null);
    setStep((prev) => Math.max(1, prev - 1) as any);
  };

  const rulePayloadCore = (r: OfferRuleDraft) => ({
    type: r.type,
    discountPercent: r.type === "PERCENT" ? r.discountPercent : undefined,
    discountAmount: r.type === "AMOUNT" ? r.discountAmount : undefined,
    maxDiscountAmount: r.maxDiscountAmount || null,
    fixedPrice: r.type === "FIXED_PRICE" ? r.fixedPrice : undefined,
    bundlePrice: r.type === "BUNDLE_PRICE" ? r.bundlePrice : undefined,
    bundleMode: r.type === "BUNDLE_PRICE" ? r.bundleMode : undefined,
    bundleQuantity:
      r.type === "BUNDLE_PRICE" && r.bundleMode === "PICK_ANY_N" ? r.bundleQuantity : undefined,
    bogoBuyQuantity: r.type === "BOGO" ? r.bogoBuyQuantity : undefined,
    bogoGetQuantity: r.type === "BOGO" ? r.bogoGetQuantity : undefined,
    bogoGetDiscountPercent: r.type === "BOGO" ? r.bogoGetDiscountPercent : undefined,
    tieredMode: r.type === "TIERED_QTY" ? r.tieredMode : undefined,
    tiers: sanitizeRuleTiers(r),
  });

  const handleSubmit = () => {
    if (isHydratingEdit) return;
    setError(null);
    for (let s = 1; s <= 4; s++) {
      const err = validateStep(s);
      if (err) {
        setStep(s as any);
        setError(err);
        return;
      }
    }

    const r0 = rules[0]!;
    const cleanName = name.trim();
    const resolvedBranchId = isAdmin ? (branchId ? parseInt(branchId, 10) : null) : undefined;
    const hasRuleFreeShipping = rules.some((r) => r.type === "FREE_SHIPPING");
    const freeShipFlag = shippingPerkMode === "FREE" || r0.type === "FREE_SHIPPING";
    const shipDiscVal =
      !hasRuleFreeShipping && shippingPerkMode === "DISCOUNT" && shippingDiscountAmount
        ? shippingDiscountAmount
        : undefined;

    if (editingId != null) {
      updateM.mutate({
        promotionId: editingId,
        campaignId: campaignId ? parseInt(campaignId, 10) : null,
        isActive,
        name: cleanName,
        description: description.trim() || null,
        ...rulePayloadCore(r0),
        scope: r0.scope,
        channel,
        ...(resolvedBranchId !== undefined ? { branchId: resolvedBranchId } : {}),
        freeShipping: freeShipFlag,
        shippingDiscountAmount: shipDiscVal ?? "0",
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        customerTier: customerTier || null,
        minLineAmount: r0.minLineAmount || undefined,
        minOrderSpend: minOrderSpend || undefined,
        priority: parseInt(priority, 10) || 0,
        applicationMode,
        allowBelowCost: r0.allowBelowCost,
        applyToBaseUnitOnly: r0.applyToBaseUnitOnly,
        activeDays: activeDays.length > 0 ? activeDays : null,
        targets: buildTargetsForHolder(r0),
      });
      return;
    }

    const extraRulesPayload =
      rules.length > 1
        ? rules.slice(1).map((er) => ({
            ruleLabel: er.ruleLabel.trim() || null,
            ...rulePayloadCore(er),
            ...(scopeSharingMode === "PER_RULE"
              ? {
                  scope: er.scope,
                  targets: buildTargetsForHolder(er),
                  allowBelowCost: er.allowBelowCost,
                  applyToBaseUnitOnly: er.applyToBaseUnitOnly,
                  minLineAmount: er.minLineAmount || undefined,
                }
              : {}),
          }))
        : undefined;

    createM.mutate({
      name: cleanName,
      primaryRuleLabel: rules.length > 1 ? r0.ruleLabel.trim() || null : undefined,
      description: description.trim() || null,
      campaignId: campaignId ? parseInt(campaignId, 10) : null,
      priority: parseInt(priority, 10) || 0,
      applicationMode,
      ...rulePayloadCore(r0),
      scope: r0.scope,
      channel,
      ...(resolvedBranchId !== undefined ? { branchId: resolvedBranchId } : {}),
      freeShipping: freeShipFlag,
      shippingDiscountAmount: shipDiscVal,
      effectiveFrom,
      effectiveTo: effectiveTo || null,
      customerTier: customerTier || null,
      minLineAmount: r0.minLineAmount || undefined,
      minOrderSpend: minOrderSpend || undefined,
      allowBelowCost: r0.allowBelowCost,
      applyToBaseUnitOnly: r0.applyToBaseUnitOnly,
      activeDays: activeDays.length > 0 ? activeDays : null,
      targets: buildTargetsForHolder(r0),
      additionalRules: extraRulesPayload,
    });
  };

  const r0 = rules[0]!;
  const hasFreeShippingRule = rules.some((r) => r.type === "FREE_SHIPPING");
  const currentFormData: OfferFormData = {
    id: editingId ?? undefined,
    name,
    description,
    campaignId,
    priority,
    applicationMode,
    type: r0.type,
    discountPercent: r0.discountPercent,
    discountAmount: r0.discountAmount,
    maxDiscountAmount: r0.maxDiscountAmount,
    fixedPrice: r0.fixedPrice,
    bundlePrice: r0.bundlePrice,
    bundleMode: r0.bundleMode,
    bundleQuantity: r0.bundleQuantity,
    bogoBuyQuantity: r0.bogoBuyQuantity,
    bogoGetQuantity: r0.bogoGetQuantity,
    bogoGetDiscountPercent: r0.bogoGetDiscountPercent,
    tieredMode: r0.tieredMode,
    tiers: r0.tiers,
    scope: r0.scope,
    selectedCategories: r0.selectedCategories,
    selectedProducts: r0.selectedProducts,
    allowBelowCost: r0.allowBelowCost,
    applyToBaseUnitOnly: r0.applyToBaseUnitOnly,
    minLineAmount: r0.minLineAmount,
    minOrderSpend,
    channel,
    branchId,
    freeShipping: shippingPerkMode === "FREE" || hasFreeShippingRule,
    shippingDiscountAmount,
    effectiveFrom,
    effectiveTo,
    customerTier,
    activeDays,
    extraRules: rules.slice(1),
    scopeSharingMode,
  };

  const previewRuleForTable = rules[currentScopeIdx] ?? r0;

  return (
    <Card className="border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-3 border-b border-border">
        <div>
          <CardTitle className="text-base font-bold">
            {editingId != null ? "تعديل العرض" : "إضافة عرض وتخفيض جديد"}
          </CardTitle>
          <div className="text-xs text-muted-foreground mt-0.5">
            الخطوة {step} من 4:{" "}
            {step === 1 && "اسم العرض وتفاصيله"}
            {step === 2 && "نوع الخصم وقيمته"}
            {step === 3 && "المواد والأقسام المشمولة"}
            {step === 4 && "مكان العرض والمدة والتجربة"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {editingId != null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => duplicateM.mutate({ promotionId: editingId })}
              disabled={duplicateM.isPending}
              className="gap-1.5 h-8"
            >
              <Copy className="size-3.5" /> نسخ العرض
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onCancel} className="size-8">
            <X className="size-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-4 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          {[
            { num: 1, title: "معلومات العرض" },
            { num: 2, title: rules.length > 1 ? `نوع الخصم (${rules.length})` : "نوع الخصم" },
            { num: 3, title: "المواد المشمولة" },
            { num: 4, title: "المكان والمدة" },
          ].map((st) => (
            <button
              key={st.num}
              type="button"
              onClick={() => {
                if (st.num < step || !validateStep(step)) setStep(st.num as any);
              }}
              className={`flex items-center justify-center gap-1.5 p-2 rounded-md border text-center transition-colors ${
                step === st.num
                  ? "border-primary bg-primary/10 font-bold text-primary"
                  : step > st.num
                  ? "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                  : "border-border text-muted-foreground opacity-60"
              }`}
            >
              {step > st.num ? <Check className="size-3.5" /> : <span>{st.num}.</span>}
              <span className="truncate">{st.title}</span>
            </button>
          ))}
        </div>

        {isHydratingEdit && (
          <div className="flex items-center justify-center gap-2 rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span>{ACTION_LABELS.loading}</span>
          </div>
        )}

        {/* Step 1: Basic Info */}
        {step === 1 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="اسم العرض" required className="md:col-span-3">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثال: عروض ملازم السادس الإعدادي 2026"
                dir="auto"
              />
            </Field>
            <Field label="الوصف (اختياري)" className="md:col-span-3">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="تفاصيل العرض والشروط العامة..."
                rows={2}
              />
            </Field>
            <Field label="الحملة (اختياري)">
              <AppSelect
                value={campaignId}
                onValueChange={setCampaignId}
                className="h-9 border-input px-3 py-1 text-sm"
              >
                <option value="">عرض مستقل (بلا حملة)</option>
                {(campaignsQ.data ?? []).map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
              </AppSelect>
            </Field>
            <Field label="الأولوية" hint="الرقم الأعلى يتقدم؛ وإذا تساوت يفوز الخصم الأكبر للزبون">
              <Input
                type="number"
                min={0}
                max={999}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </Field>
            <Field label="طريقة تفعيل الخصم">
              <AppSelect
                value={applicationMode}
                onValueChange={(v) => setApplicationMode(v as ApplicationMode)}
                className="h-9 border-input px-3 py-1 text-sm"
              >
                <option value="AUTO">{APPLICATION_LABELS.AUTO} (ينزل بالسلة مباشرة بدون كود)</option>
                <option value="COUPON">{APPLICATION_LABELS.COUPON}</option>
              </AppSelect>
            </Field>
          </div>
        )}

        {/* Step 2: Type & Value */}
        {step === 2 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {editingId == null && (
              <div className="md:col-span-3">
                <OfferMultiRuleBar
                  rules={rules}
                  activeIndex={activeRuleIdx}
                  onSelectRule={setActiveRuleIdx}
                  onAddRule={() => handleAddRuleWithType("BUNDLE_PRICE")}
                  onRemoveRule={handleRemoveRule}
                  onChangeActiveRuleLabel={(lbl) => updateActiveRule({ ruleLabel: lbl })}
                />
              </div>
            )}

            <div className="md:col-span-3">
              <OfferTypeCards
                value={activeRule.type}
                onChange={(nextType) => updateActiveRule({ type: nextType })}
                activeTypesInOffer={rules.map((r) => r.type)}
                onAddAsNewRule={editingId == null ? handleAddRuleWithType : undefined}
              />
            </div>

            <Field label="نوع الخصم" required className="md:col-span-3">
              <AppSelect
                value={activeRule.type}
                onValueChange={(v) => updateActiveRule({ type: v as PromoType })}
                className="h-9 border-input px-3 py-1 text-sm"
              >
                <option value="PERCENT">{PROMO_TYPE_LABELS.PERCENT}</option>
                <option value="AMOUNT">{PROMO_TYPE_LABELS.AMOUNT}</option>
                <option value="FIXED_PRICE">{PROMO_TYPE_LABELS.FIXED_PRICE}</option>
                <option value="BUNDLE_PRICE">{PROMO_TYPE_LABELS.BUNDLE_PRICE}</option>
                <option value="BOGO">{PROMO_TYPE_LABELS.BOGO}</option>
                <option value="TIERED_QTY">{PROMO_TYPE_LABELS.TIERED_QTY}</option>
                <option value="FREE_SHIPPING">{PROMO_TYPE_LABELS.FREE_SHIPPING}</option>
              </AppSelect>
            </Field>

            <OfferRuleValueFields activeRule={activeRule} onUpdateRule={updateActiveRule} />
          </div>
        )}

        {/* Step 3: Scope & 3-Way Bulk Product Addition */}
        {step === 3 && (
          <div className="space-y-4">
            {rules.length > 1 && (
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-foreground">
                    طريقة ربط المواد بالقواعد ({rules.length} قواعد):
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant={scopeSharingMode === "SHARED" ? "default" : "outline"}
                      className="h-7 text-xs"
                      onClick={() => setScopeSharingMode("SHARED")}
                    >
                      نفس المواد لكل القواعد (يفوز الأوفر للزبون تلقائياً)
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={scopeSharingMode === "PER_RULE" ? "default" : "outline"}
                      className="h-7 text-xs"
                      onClick={() => setScopeSharingMode("PER_RULE")}
                    >
                      نطاق ومواد مستقلة لكل قاعدة
                    </Button>
                  </div>
                </div>

                {scopeSharingMode === "PER_RULE" && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/60">
                    {rules.map((r, idx) => (
                      <Button
                        key={r.key}
                        type="button"
                        size="sm"
                        variant={currentScopeIdx === idx ? "default" : "outline"}
                        className="h-7 text-xs"
                        onClick={() => setScopeRuleIdx(idx)}
                      >
                        قاعدة {idx + 1}: {summarizeRuleDraft(r)} (
                        {r.scope === "PRODUCTS"
                          ? `${r.selectedProducts.length} مادة`
                          : r.scope === "CATEGORIES"
                          ? `${r.selectedCategories.length} فئة`
                          : "الكل"}
                        )
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <Field label="النطاق" required>
              <div className="flex gap-2 flex-wrap">
                {(["ALL", "CATEGORIES", "PRODUCTS"] as PromoScope[]).map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant={targetScopeRule.scope === s ? "default" : "outline"}
                    size="sm"
                    onClick={() => updateScopeRule((r) => ({ ...r, scope: s }))}
                  >
                    {s === "ALL" && "كل بضاعة المحل"}
                    {s === "CATEGORIES" && "أقسام محددة"}
                    {s === "PRODUCTS" && "مواد محددة"}
                  </Button>
                ))}
              </div>
            </Field>

            {targetScopeRule.scope === "CATEGORIES" && (
              <div className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">اختر الأقسام المشمولة بالعرض:</span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() =>
                        updateScopeRule((r) => ({
                          ...r,
                          selectedCategories: (categoriesQ.data ?? []).map((c) => c.id),
                        }))
                      }
                    >
                      تحديد كل الأقسام
                    </Button>
                    {targetScopeRule.selectedCategories.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => updateScopeRule((r) => ({ ...r, selectedCategories: [] }))}
                      >
                        إلغاء التحديد
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(categoriesQ.data ?? []).map((cat) => {
                    const isSelected = targetScopeRule.selectedCategories.includes(cat.id);
                    return (
                      <Button
                        key={cat.id}
                        type="button"
                        variant={isSelected ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          updateScopeRule((r) => ({
                            ...r,
                            selectedCategories: isSelected
                              ? r.selectedCategories.filter((id) => id !== cat.id)
                              : [...r.selectedCategories, cat.id],
                          }))
                        }
                      >
                        {cat.name}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            {targetScopeRule.scope === "PRODUCTS" && (
              <div className="space-y-3">
                <OfferBulkAddToolbar
                  categories={categoriesQ.data ?? []}
                  selectedItems={targetScopeRule.selectedProducts}
                  onAddItems={(items) =>
                    updateScopeRule((r) => {
                      const ids = new Set(r.selectedProducts.map((x) => x.variantId));
                      return {
                        ...r,
                        selectedProducts: [
                          ...r.selectedProducts,
                          ...items.filter((x) => !ids.has(x.variantId)),
                        ],
                      };
                    })
                  }
                  onClearAll={() => updateScopeRule((r) => ({ ...r, selectedProducts: [] }))}
                />

                <OfferProductSearchInput
                  selectedItems={targetScopeRule.selectedProducts}
                  onAddItem={(item) =>
                    updateScopeRule((r) =>
                      r.selectedProducts.some((x) => x.variantId === item.variantId)
                        ? r
                        : { ...r, selectedProducts: [...r.selectedProducts, item] }
                    )
                  }
                  onAddItems={(items) =>
                    updateScopeRule((r) => {
                      const ids = new Set(r.selectedProducts.map((x) => x.variantId));
                      return {
                        ...r,
                        selectedProducts: [
                          ...r.selectedProducts,
                          ...items.filter((x) => !ids.has(x.variantId)),
                        ],
                      };
                    })
                  }
                />

                <OfferSelectedItemsTable
                  items={targetScopeRule.selectedProducts}
                  promoType={previewRuleForTable.type}
                  promoValue={
                    previewRuleForTable.type === "PERCENT"
                      ? previewRuleForTable.discountPercent
                      : previewRuleForTable.type === "AMOUNT"
                      ? previewRuleForTable.discountAmount
                      : previewRuleForTable.type === "FIXED_PRICE"
                      ? previewRuleForTable.fixedPrice
                      : "0"
                  }
                  onUpdateUnit={(varId, newUnitId) =>
                    updateScopeRule((r) => ({
                      ...r,
                      selectedProducts: r.selectedProducts.map((item) => {
                        if (item.variantId !== varId) return item;
                        const u = item.units.find((unit) => unit.id === newUnitId);
                        return {
                          ...item,
                          productUnitId: newUnitId,
                          unitName: u?.unitName ?? item.unitName,
                          conversionFactor: u?.conversionFactor ?? item.conversionFactor,
                          retailPrice: u?.retailPrice ?? item.retailPrice,
                          barcode: u?.barcode ?? item.barcode,
                          isBaseUnit: u?.isBaseUnit ?? item.isBaseUnit,
                        };
                      }),
                    }))
                  }
                  onRemoveItem={(varId) =>
                    updateScopeRule((r) => ({
                      ...r,
                      selectedProducts: r.selectedProducts.filter((item) => item.variantId !== varId),
                    }))
                  }
                />
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-border">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={targetScopeRule.allowBelowCost}
                  onChange={(e) =>
                    updateScopeRule((r) => ({ ...r, allowBelowCost: e.target.checked }))
                  }
                  className="rounded border-border text-primary"
                />
                <span>السماح بالبيع جوا الكلفة (تحت التكلفة) بموافقة الإدارة</span>
              </label>

              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={targetScopeRule.applyToBaseUnitOnly}
                  onChange={(e) =>
                    updateScopeRule((r) => ({ ...r, applyToBaseUnitOnly: e.target.checked }))
                  }
                  className="rounded border-border text-primary"
                />
                <span>تطبيق العرض على القطعة المفردة فقط (استثناء الدرزن والكارتون)</span>
              </label>

              <Field label="أقل مبلغ للمادة بالسطر الواحد (اختياري)">
                <MoneyInput
                  value={targetScopeRule.minLineAmount}
                  onChange={(val) => updateScopeRule((r) => ({ ...r, minLineAmount: val }))}
                  placeholder="0 د.ع"
                />
              </Field>
            </div>
          </div>
        )}

        {/* Step 4: Comprehensive Channels, Branches, Delivery Perks, Scheduling & Simulator */}
        {step === 4 && (
          <div className="space-y-4">
            <OfferChannelStepSection
              channel={channel}
              onChannelChange={setChannel}
              branchId={branchId}
              onBranchIdChange={setBranchId}
              branches={branchesQ.data ?? []}
              isAdmin={isAdmin}
              userBranchId={meQ.data?.branchId}
              shippingPerkMode={shippingPerkMode}
              onShippingPerkModeChange={setShippingPerkMode}
              shippingDiscountAmount={shippingDiscountAmount}
              onShippingDiscountAmountChange={setShippingDiscountAmount}
              hasFreeShippingRule={hasFreeShippingRule}
            />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Field label="قناة العرض">
                <AppSelect
                  value={channel === "POS" ? "POS_ONLY" : channel === "STORE" ? "STORE_ONLY" : channel}
                  onValueChange={(v) => setChannel(v as PromoChannel)}
                  className="h-9 border-input px-3 py-1 text-sm"
                >
                  <option value="ALL">{CHANNEL_LABELS.ALL}</option>
                  <option value="POS_ONLY">{CHANNEL_LABELS.POS_ONLY}</option>
                  <option value="STORE_ONLY">{CHANNEL_LABELS.STORE_ONLY}</option>
                </AppSelect>
              </Field>

              <Field label="من تاريخ" required>
                <Input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              </Field>

              <Field label="إلى تاريخ" hint="اتركه فارغاً لعرض مستمر">
                <div className="space-y-1.5">
                  <Input
                    type="date"
                    value={effectiveTo}
                    onChange={(e) => setEffectiveTo(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-1">
                    {[
                      { label: "مستمر", val: "" },
                      { label: "7 أيام", val: addDaysYmd(effectiveFrom || todayYmd(), 7) },
                      { label: "نهاية الشهر", val: endOfMonthYmd(effectiveFrom || todayYmd()) },
                      { label: "نهاية السنة", val: `${(effectiveFrom || todayYmd()).slice(0, 4)}-12-31` },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setEffectiveTo(preset.val)}
                        className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] hover:bg-muted"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              </Field>

              <Field label="نوع الزبون (اختياري)">
                <AppSelect
                  value={customerTier}
                  onValueChange={(v) => setCustomerTier(v as CustomerTier)}
                  className="h-9 border-input px-3 py-1 text-sm"
                >
                  <option value="">{CUSTOMER_TIER_LABELS[""]}</option>
                  <option value="RETAIL">{CUSTOMER_TIER_LABELS.RETAIL}</option>
                  <option value="WHOLESALE">{CUSTOMER_TIER_LABELS.WHOLESALE}</option>
                  <option value="GOVERNMENT">{CUSTOMER_TIER_LABELS.GOVERNMENT}</option>
                </AppSelect>
              </Field>

              <Field label="أقل مبلغ للفاتورة حتى يشتغل العرض (اختياري)" className="md:col-span-2">
                <MoneyInput
                  value={minOrderSpend}
                  onChange={setMinOrderSpend}
                  placeholder="مثال: 25,000 د.ع"
                />
              </Field>

              <div className="md:col-span-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-muted-foreground">
                    أيام عمل العرض بالأسبوع (فارغ = كل الأسبوع):
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setActiveDays([])}
                      className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[10px] hover:bg-muted"
                    >
                      كل الأسبوع
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveDays([4, 5, 6])}
                      className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[10px] hover:bg-muted"
                    >
                      خميس - جمعة - سبت
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {ACTIVE_DAYS_LIST.map((d) => {
                    const isDayActive = activeDays.includes(d.day);
                    return (
                      <Button
                        key={d.day}
                        type="button"
                        variant={isDayActive ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          setActiveDays((prev) =>
                            isDayActive ? prev.filter((x) => x !== d.day) : [...prev, d.day]
                          )
                        }
                      >
                        {d.label}
                      </Button>
                    );
                  })}
                </div>
              </div>

              {editingId != null && wasInitiallyInactive && (
                <label className="md:col-span-3 flex items-center gap-2 rounded-md border border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] p-2.5 text-xs font-medium text-[var(--sem-info)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="rounded border-border text-primary"
                  />
                  <span>تفعيل العرض فور الحفظ (تحويل المسودة المعطَّلة إلى عرض نشط)</span>
                </label>
              )}
            </div>

            <div className="pt-2">
              <OfferLivePreviewSimulator
                formData={currentFormData}
                selectedProducts={r0.selectedProducts}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] p-3 text-xs text-[var(--sem-neg)] flex items-start gap-2">
            <AlertCircle className="size-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-between items-center pt-3 border-t border-border">
          <Button variant="outline" size="sm" onClick={onCancel}>
            إلغاء
          </Button>
          <div className="flex items-center gap-2">
            {step > 1 && (
              <Button type="button" variant="outline" size="sm" onClick={prevStep} className="gap-1.5">
                <ArrowRight className="size-3.5" /> السابق
              </Button>
            )}
            {step < 4 ? (
              <Button type="button" size="sm" onClick={nextStep} disabled={isHydratingEdit} className="gap-1.5">
                التالي <ArrowLeft className="size-3.5" />
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={handleSubmit}
                disabled={isHydratingEdit || createM.isPending || updateM.isPending}
                className="gap-1.5"
              >
                <Save className="size-3.5" />
                {createM.isPending || updateM.isPending
                  ? ACTION_LABELS.saving
                  : editingId != null
                  ? "حفظ التعديلات"
                  : rules.length > 1
                  ? `حفظ العرض (${rules.length} قواعد)`
                  : "حفظ العرض"}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
