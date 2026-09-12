import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { LoadingState, ErrorState } from "@/components/PageState";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { D, fmt, round2 } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import {
  OPENING_ALLOCATION_ROLES,
  allocationKey,
} from "@/lib/doubleEntryRoleLabels";
import {
  AlertTriangle,
  Check,
  ClipboardList,
  FileDown,
} from "lucide-react";
import { Link } from "wouter";
import { useMemo, useState } from "react";
import { DriftSection } from "@/components/reconcile/DriftSection";
import { DoubleEntryStatus } from "@/components/reconcile/DoubleEntryStatus";
import { ReconcileReasonDialog } from "@/components/reconcile/ReconcileReasonDialog";
import { exportReconcileReport } from "@/components/reconcile/exportReconcileReport";
import type { OpeningAllocation } from "@/components/reconcile/types";

/* ═══════════ شاشة تدقيق التوافق المالي (admin فقط) ═══════════
   تستهلك reports.reconcile (adminProcedure) لكشف الانجراف الصامت بين
   الأرصدة المُشتقّة والمسجَّلة في الذمم والعهد والمخزون والدفتر.
═══════════════════════════════════════════════════════════════ */

export default function Reconcile() {
  const [month, setMonth] = useState(thisMonth());
  const [branchId, setBranchId] = useState<number | "">("");
  const [policyReference, setPolicyReference] = useState("");
  const [policyAccountantName, setPolicyAccountantName] = useState("");
  const [openingAllocationAmounts, setOpeningAllocationAmounts] = useState<
    Record<string, string>
  >({});
  /** حوار السبب الموحَّد (بديل window.prompt): إيقاف الدفتر أو مسح مصادقة السياسة.
      يُعلَن هنا مع بقيّة الحالة — أي قبل حاجز «غير المدير» أدناه — التزاماً بقاعدة الخطّافات.
      النوع منفصلٌ عن راية الفتح عمداً: تصفيرُه عند الإغلاق يقلب عناوين الحوار أثناء
      حركة الخروج فيقرأ المستعمل عنواناً غير الذي أكّده. */
  const [reasonKind, setReasonKind] = useState<"STOP" | "CLEAR_POLICY">("STOP");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonText, setReasonText] = useState("");
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isAdmin });
  // الفحص ثقيل نسبياً — لا يُطلَق إلا للمدير، وبلا إعادة جلب تلقائية.
  const recon = trpc.reports.reconcile.useQuery(
    {
      month,
      branchId: branchId ? Number(branchId) : undefined,
    },
    {
      enabled: isAdmin,
      refetchOnWindowFocus: false,
    },
  );
  const openingPreparation =
    trpc.reports.prepareDoubleEntryShadow.useMutation({
      onError: (error) => notify.err(error),
    });

  const setMode = trpc.reports.setDoubleEntryMode.useMutation({
    onSuccess: (result) => {
      notify.ok(
        result.mode === "SHADOW"
          ? "بدأ وضع الظل وسُجّل القرار في التدقيق."
          : result.mode === "ACTIVE"
            ? "اعتمد الدفتر المزدوج بوضع ACTIVE."
            : "أُوقف الدفتر المزدوج مع حفظ اليوميات التاريخية.",
      );
      setReasonOpen(false);
      setReasonText("");
      void recon.refetch();
    },
    onError: (error) => notify.err(error),
  });
  const setPolicyApproval =
    trpc.reports.setDoubleEntryPolicyApproval.useMutation({
      onSuccess: (result) => {
        notify.ok(
          "cleared" in result
            ? "مُسحت مصادقة السياسة وسُجّل السبب في التدقيق."
            : "سُجل مرجع مصادقة السياسة واسم المحاسب في التدقيق.",
        );
        setPolicyReference("");
        setPolicyAccountantName("");
        setReasonOpen(false);
        setReasonText("");
        void recon.refetch();
      },
      onError: (error) => notify.err(error),
    });

  const data = recon.data;

  // أسماء الأطراف لعرضها بجانب المعرّفات الرقمية — تُجلَب فقط عند وجود انحرافات فعلية لهذا
  // المحور (لا داعٍ لجلب القوائم الكاملة عند عدم وجود صفوف تحتاجها). هذه الاستعلامات (وما
  // تحتها من useMemo) يجب أن تُستدعى في كل تصيير بلا شرط (قاعدة الخطاطيف) — لذا هي **قبل**
  // حاجز «غير المدير» أدناه لا بعده، رغم أنها لا تُفعَّل (enabled) إلا للمدير أصلاً.
  const customersQ = trpc.customers.list.useQuery(undefined, {
    enabled: isAdmin && !!data?.customers.length,
  });
  const suppliersQ = trpc.suppliers.list.useQuery(undefined, {
    enabled: isAdmin && !!data?.suppliers.length,
  });
  const partiesQ = trpc.delivery.listParties.useQuery(
    {},
    { enabled: isAdmin && !!data?.delivery.length },
  );
  const customerNames = useMemo(
    () => new Map((customersQ.data ?? []).map((c) => [c.id, c.name])),
    [customersQ.data],
  );
  const supplierNames = useMemo(
    () => new Map((suppliersQ.data ?? []).map((s) => [s.id, s.name])),
    [suppliersQ.data],
  );
  const partyNames = useMemo(
    () => new Map((partiesQ.data ?? []).map((p) => [p.id, p.name])),
    [partiesQ.data],
  );

  // غير المدير: حاجز واضح (الخادم يرفضها أصلاً بـadminProcedure — هذا دفاع طبقي + رسالة لطيفة).
  if (me.data && !isAdmin) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        هذه الشاشة مخصّصة لمسؤول النظام فقط.
      </div>
    );
  }

  const doubleEntryIssues = data
    ? data.doubleEntry.roles.filter((row) => row.drift !== "0.00").length +
      data.doubleEntry.gapCount +
      data.doubleEntry.missingCount +
      data.doubleEntry.extraCount +
      data.doubleEntry.scopeMismatchCount +
      data.doubleEntry.unreconstructableCount +
      data.doubleEntry.sourceMismatchCount +
      data.doubleEntry.imbalancedJournalCount
    : 0;
  const total = data
    ? data.customers.length +
      data.suppliers.length +
      data.delivery.length +
      data.inventory.length +
      data.ledger.length +
      // Codex P1 #2 (٢٦/٨): محور طلبات المتجر — لو نُسي هنا لَعرض الملخصُ «صفر انحراف»
      // بينما الليل يُصدر WARN، ولحُرم المدير من الصفوف اللازمة للتصحيح اليدويّ.
      (data.onlineOrders?.length ?? 0) +
      // Tier-3 #5 (٢٧/٨): محور أيتام journalLines — نفس السبب: لو نُسي هنا لصار WARN
      // الليلة صامتاً عن المدير.
      (data.journalOrphans?.length ?? 0) +
      doubleEntryIssues
    : 0;
  const loading = me.isLoading || (isAdmin && recon.isLoading);

  // تصدير Excel — ورقة مستقلّة لكل محور بنفس بيانات الجدول المعروض (تشمل الأسماء حيث توفّرت).
  function exportAll() {
    if (!data) return;
    exportReconcileReport({
      data,
      branchId,
      branches: branches.data,
      customerNames,
      supplierNames,
      partyNames,
    });
  }

  async function requestActivation() {
    if (
      !(await confirm({
        variant: "danger",
        title: "اعتماد الدفتر المزدوج بوضع ACTIVE؟",
        description:
          "بعد التفعيل سيفشل أي حدث مالي لا يملك خريطة أو بيانات مكتملة، وستتراجع معاملة الأعمال كاملة. هل راجعت كل موانع البوابة وتريد المتابعة؟",
        confirmText: "اعتماد ACTIVE",
      }))
    )
      return;
    setMode.mutate({ target: "ACTIVE" });
  }

  async function requestStartShadow() {
    const prepared = openingPreparation.data;
    if (!prepared) {
      notify.warn("أعدّ معاينة الافتتاح أولاً.");
      return;
    }
    if (!prepared.preview.canApprove) {
      notify.warn("لا يمكن بدء الظل قبل معالجة موانع لقطة الافتتاح.");
      return;
    }
    if (
      !(await confirm({
        variant: "warning",
        title: "تأكيد لقطة القطع وبدء وضع الظل؟",
        description:
          "ستُعاد مطابقة البصمة داخل معاملة ذرية. اللقطة تنقل أرصدة الميزانية عند القطع ولا تعيد بناء أرباح وخسائر ما قبل تاريخ القطع.",
        confirmText: "بدء وضع الظل",
      }))
    )
      return;
    setMode.mutate({
      target: "SHADOW",
      preparationToken: prepared.preparationToken,
      expectedOpeningHash: prepared.preview.openingHash,
      allocations: prepared.preview.manualAllocations,
    });
  }

  function prepareInitialOpening() {
    setOpeningAllocationAmounts({});
    openingPreparation.mutate({ allocations: [] });
  }

  function prepareAllocatedOpening() {
    const prepared = openingPreparation.data;
    if (!prepared) return;
    const allocations: OpeningAllocation[] = [];
    try {
      for (const scope of prepared.preview.unallocatedOpeningBalance.scopes) {
        let allocated = D(0);
        for (const role of OPENING_ALLOCATION_ROLES) {
          const raw = (openingAllocationAmounts[allocationKey(scope.branchId, role)] ?? "").trim();
          if (!raw) continue;
          if (!/^\\d+(?:\\.\\d{1,2})?$/.test(raw) || !D(raw).isPositive()) {
            notify.warn("كل مبلغ تخصيص يجب أن يكون موجباً وبدقة منزلتين كحد أقصى.");
            return;
          }
          const amount = round2(D(raw)).toFixed(2);
          allocated = allocated.plus(amount);
          allocations.push({
            role,
            branchId: scope.branchId,
            debit: scope.debit !== "0.00" ? amount : "0.00",
            credit: scope.credit !== "0.00" ? amount : "0.00",
          });
        }
        const required = D(scope.debit).plus(scope.credit);
        if (!round2(allocated).eq(round2(required))) {
          notify.warn(
            `تخصيص النطاق ${scope.branchId == null ? "العام" : `فرع ${scope.branchId}`} يجب أن يساوي ${fmt(required.toFixed(2))}.`,
          );
          return;
        }
      }
    } catch {
      notify.warn("تعذّر قراءة مبالغ التخصيص؛ راجع القيم المدخلة.");
      return;
    }
    openingPreparation.mutate({ allocations });
  }

  /** إيقاف الدفتر المزدوج — السبب إلزاميّ (10 أحرف فأكثر) والتأكيد صريحٌ في الحوار نفسه. */
  function requestStop() {
    setReasonText("");
    setReasonKind("STOP");
    setReasonOpen(true);
  }

  function approvePolicy() {
    const reference = policyReference.trim();
    const accountantName = policyAccountantName.trim();
    if (reference.length < 10) {
      notify.warn("مرجع المصادقة يجب ألا يقل عن 10 أحرف.");
      return;
    }
    if (accountantName.length < 3) {
      notify.warn("اسم المحاسب يجب ألا يقل عن 3 أحرف.");
      return;
    }
    setPolicyApproval.mutate({
      action: "APPROVE",
      reference,
      accountantName,
    });
  }

  /** مسح مصادقة السياسة — السبب إلزاميّ (10 أحرف فأكثر) ويُحفظ في سجل التدقيق. */
  function clearPolicyApproval() {
    setReasonText("");
    setReasonKind("CLEAR_POLICY");
    setReasonOpen(true);
  }

  /** إرسال حوار السبب — يحفظ نفس الحدّ الأدنى ونفس رسائل التحذير لكلا المسارين.
      الزرّ مُعطَّل تحت 10 أحرف، والفحص هنا يبقى دفاعاً ثانياً لا يُسقَط. */
  function submitReasonDialog() {
    const trimmed = reasonText.trim();
    if (reasonKind === "STOP") {
      if (trimmed.length < 10) {
        notify.warn("سبب الإيقاف يجب ألا يقل عن 10 أحرف.");
        return;
      }
      setMode.mutate({ target: "OFF", reason: trimmed });
      return;
    }
    if (reasonKind === "CLEAR_POLICY") {
      if (trimmed.length < 10) {
        notify.warn("سبب المسح يجب ألا يقل عن 10 أحرف.");
        return;
      }
      setPolicyApproval.mutate({ action: "CLEAR", reason: trimmed });
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تدقيق التوافق المالي"
        description="يكشف الانجراف الصامت في ذمم العملاء والموردين، عهدة تحصيلات التوصيل، المخزون والدفتر. الأخضر = متوازن، الأحمر = انحراف يستوجب المراجعة. لا يصحّح النظام أي فرق بصمت."
        actions={
          <div className="flex items-center gap-3">
            {data && (
              <span className="text-xs text-muted-foreground" dir="ltr">
                آخر فحص:{" "}
                <span dir="ltr" className="tabular-nums">
                  {fmtDateTime(data.runAt)}
                </span>
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!data}
              onClick={exportAll}
              className="inline-flex items-center gap-1.5"
            >
              <FileDown aria-hidden className="size-4" />
              تصدير Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!isAdmin || recon.isFetching}
              onClick={() => recon.refetch()}
            >
              {recon.isFetching ? "جارٍ الفحص…" : "إعادة الفحص"}
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">
              شهر المطابقة
            </label>
            <MonthPicker
              value={month}
              onChange={setMonth}
              ariaLabel="شهر مطابقة الدفتر المزدوج"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect
              className="h-9"
              value={String(branchId)}
              onValueChange={(next) =>
                setBranchId(
                  next ? Number(next) : "",
                )
              }
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <p className="max-w-xl text-xs text-muted-foreground">
            نطاق التقرير يتبع تاريخ القيد داخل الشهر والفرع المختارين. بوابة
            ACTIVE مستقلة وتفحص كل الأحداث منذ بدء الظل على جميع الفروع.
          </p>
        </CardContent>
      </Card>

      {loading && <LoadingState />}

      {recon.error && (
        <ErrorState
          message={`تعذّر التدقيق: ${recon.error.message}`}
          onRetry={() => recon.refetch()}
        />
      )}

      {data && !recon.error && (
        <>
          <DoubleEntryStatus
            reconciliation={data.doubleEntry}
            activation={data.activation}
            openingPreparation={openingPreparation.data ?? null}
            openingPreparationError={openingPreparation.error?.message ?? null}
            preparingOpening={openingPreparation.isPending}
            busy={
              setMode.isPending ||
              setPolicyApproval.isPending ||
              openingPreparation.isPending
            }
            openingAllocationAmounts={openingAllocationAmounts}
            onOpeningAllocationAmountChange={(key, value) =>
              setOpeningAllocationAmounts((current) => ({
                ...current,
                [key]: value,
              }))
            }
            policyReference={policyReference}
            policyAccountantName={policyAccountantName}
            onPolicyReferenceChange={setPolicyReference}
            onPolicyAccountantNameChange={setPolicyAccountantName}
            onApprovePolicy={approvePolicy}
            onClearPolicy={clearPolicyApproval}
            onPrepareShadow={prepareInitialOpening}
            onPrepareAllocatedShadow={prepareAllocatedOpening}
            onStartShadow={requestStartShadow}
            onActivate={requestActivation}
            onStop={requestStop}
          />

          {/* لونُ الانحراف دلاليّ لا مخزنيّ: كان `badge-stock-out` — توكن «نفد المخزون» —
              في شاشة مطابقةٍ نقديّة لا مخزون فيها. الدلالة هنا خطرٌ يستوجب المراجعة، فصار
              `--sem-neg` (نفس الأحمر الطوبيّ قيمةً، والصنف صار يصف ما يعنيه). */}
          <Card>
            <CardContent
              className={`p-6 text-center text-lg font-bold inline-flex items-center justify-center gap-2 w-full ${
                total === 0 ? "badge-status-active" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
              }`}
            >
              {total === 0 ? (
                <>
                  <Check aria-hidden className="size-5" />
                  كل المحاور متوازنة — لا انحراف
                </>
              ) : (
                <>
                  <AlertTriangle aria-hidden className="size-5" />
                  {`${total} انحراف يستوجب المراجعة`}
                </>
              )}
            </CardContent>
          </Card>

          <DriftSection
            title="ذمم العملاء"
            desc="الفرق بين الرصيد المُشتقّ من الفواتير (إجمالي − مدفوع − مُرتجَع) والمسجَّل في currentBalance."
            idLabel="رقم العميل"
            money
            rows={data.customers}
            names={customerNames}
            link={(id) => `/customers-statement?id=${id}`}
            linkLabel="كشف الحساب"
          />

          <DriftSection
            title="ذمم الموردين"
            desc="الفرق بين الرصيد المُشتقّ من المشتريات والتسديدات والمسجَّل على المورد."
            idLabel="رقم المورد"
            money
            rows={data.suppliers}
            names={supplierNames}
            link={(id) => `/suppliers-statement?id=${id}`}
            linkLabel="كشف الحساب"
          />

          <DriftSection
            title="عهدة تحصيلات التوصيل"
            desc="الفرق بين مبالغ COD المسلّمة للمندوب والمبالغ المورّدة أو المشطوبة وبين رصيده المسجّل."
            idLabel="رقم جهة التوصيل"
            money
            rows={data.delivery}
            names={partyNames}
            link={() => "/delivery?tab=parties"}
            linkLabel="جهات التوصيل"
          />

          <DriftSection
            title="أرصدة المخزون"
            desc="رصيد سالب لمتغيّر في فرع — يجب ألّا يقلّ عن صفر."
            idLabel="رقم المتغيّر"
            rows={data.inventory}
            link={() => `/inventory`}
            linkLabel="المخزون"
            action={
              data.inventory.length > 0 ? (
                <Link
                  href={`/stocktakes/new?variants=${Array.from(new Set(data.inventory.map((r) => r.id))).join(",")}&name=${encodeURIComponent("جرد تحقّق — انحرافات التدقيق المالي")}`}
                >
                  <Button
                    size="sm"
                    className="inline-flex items-center gap-1.5"
                  >
                    <ClipboardList aria-hidden className="size-4" />
                    أنشئ جلسة جرد لهذه المنتجات
                  </Button>
                </Link>
              ) : null
            }
          />

          <DriftSection
            title="قيود الدفتر"
            desc="قيود لا يتطابق فيها الربح مع (الإيراد − التكلفة)."
            idLabel="رقم القيد"
            money
            rows={data.ledger}
          />

          {/*
            Tier-2 #4 (٢٦/٨): سلامة الربط بين طلب المتجر والإرسالية — أربع حالاتٍ حاكمة
            (يحسبها `reconcileOnlineOrderConsignmentSync`). العمود «الانحراف» رقمٌ رمزيّ
            (١ لكل صفّ)، والمحتوى الحاكم في `note` الذي يسمّي الطلب والإرسالية والحالة.
          */}
          <DriftSection
            title="طلبات المتجر × الإرساليات"
            desc="فروق حالة/إسناد بين onlineOrders وdeliveryConsignments — الإصلاح يدويّ بفتح الطلب."
            idLabel="رقم الطلب"
            rows={data.onlineOrders ?? []}
            link={(id) => `/store-admin/orders/${id}`}
            linkLabel="فتح الطلب"
          />

          {/*
            Tier-3 #5 (٢٧/٨): أيتام journalLines بلا accountId. الحالة الطبيعية «صفر»: كل
            سطرٍ POSTED جديد يحمل accountId بعد Tier-3 #2/#4. أيّ صفٍّ هنا يعني إمّا خرقاً
            من backfill أو drift في `accounts.systemRole` — الإصلاح في السجلاّت التاريخيّة.
          */}
          <DriftSection
            title="أيتام قيود الدفتر"
            desc="أسطرٌ في journalLines بلا accountId — خرقُ عقد الكاتب بعد أن أصبح الحقل يُملأ تلقائياً من الرأس."
            idLabel="رقم السطر"
            rows={data.journalOrphans ?? []}
          />
        </>
      )}

      {/* حوار السبب الموحَّد — بديل window.prompt + window.confirm المتتاليَين.
          يجمع في خطوةٍ واحدة: السبب الإلزاميّ (10 أحرف فأكثر، مطابقاً لعقد الخادم 10..500)
          ونصّ التحذير الذي كان في window.confirm، فلا يسقط حارسٌ ولا معلومة. */}
      <ReconcileReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        reasonKind={reasonKind}
        reasonText={reasonText}
        onReasonTextChange={setReasonText}
        isPending={setMode.isPending || setPolicyApproval.isPending}
        onSubmit={submitReasonDialog}
      />
    </div>
  );
}
