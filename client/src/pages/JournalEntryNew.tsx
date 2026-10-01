/**
 * JournalEntryNew — شاشة إنشاء قيد يومية يدوي (Double-Entry Manual Journal).
 *
 * صُممت وفق الأصول المحاسبية الصارمة وضوابط الحوكمة ERP:
 * 1. ميزان فوري حي لقيد اليومية (إجمالي المدين = إجمالي الدائن).
 * 2. التحقق من تكافؤ القيد قبل الإرسال لمنع الترحيل غير المتوازن.
 * 3. حوكمة الفترات المالية المقفلة وتكامل دفاتر الأستاذ العام والمساعد.
 * 4. واجهة رشيقة وسريعة تدعم الاختصارات وإدخال أسطر متعددة بسلاسة.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertCircle,
  CheckCircle2,
  Plus,
  Scale,
  Trash2,
  Building2,
  Calendar,
  FileText,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { D, fmtAr, moneyInput } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";

const FORBIDDEN_MANUAL_JOURNAL_ROLES = new Set([
  "CASH",
  "TREASURY_CASH",
  "INVENTORY",
  "CASH_IN_TRANSIT",
]);

interface JournalLineForm {
  id: string;
  accountId: string;
  debit: string;
  credit: string;
  customerId: string;
  supplierId: string;
}

const todayDate = () => new Date().toISOString().slice(0, 10);

const emptyLine = (): JournalLineForm => ({
  id: crypto.randomUUID(),
  accountId: "",
  debit: "",
  credit: "",
  customerId: "",
  supplierId: "",
});

export default function JournalEntryNew() {
  const [, navigate] = useLocation();

  const [entryDate, setEntryDate] = useState(todayDate);
  const [branchId, setBranchId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<JournalLineForm[]>([
    emptyLine(),
    emptyLine(),
  ]);

  const accountsQ = trpc.accounts.list.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const customersQ = trpc.customers.list.useQuery();
  const suppliersQ = trpc.suppliers.list.useQuery();

  const accounts = accountsQ.data ?? [];
  const branches = branchesQ.data ?? [];
  const customers = customersQ.data ?? [];
  const suppliers = suppliersQ.data ?? [];

  const accountsMap = useMemo(() => {
    const map = new Map<number, (typeof accounts)[number]>();
    for (const acc of accounts) {
      map.set(acc.id, acc);
    }
    return map;
  }, [accounts]);

  const postableAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      if (!acc.isActive) return false;
      if (!acc.systemRole) return false;
      if (FORBIDDEN_MANUAL_JOURNAL_ROLES.has(acc.systemRole)) return false;
      return true;
    });
  }, [accounts]);

  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  // الحسابات المالية اللحظية (مدين، دائن، والفرق)
  const totals = useMemo(() => {
    let sumDebit = D(0);
    let sumCredit = D(0);

    for (const line of lines) {
      const d = moneyInput(line.debit);
      const c = moneyInput(line.credit);
      sumDebit = sumDebit.plus(d);
      sumCredit = sumCredit.plus(c);
    }

    const diff = sumDebit.minus(sumCredit).abs();
    const isBalanced = sumDebit.gt(0) && sumCredit.gt(0) && sumDebit.equals(sumCredit);

    return {
      debit: sumDebit,
      credit: sumCredit,
      difference: diff,
      isBalanced,
      hasLines: lines.length >= 2,
    };
  }, [lines]);

  const createMutation = trpc.accounts.createManualJournal.useMutation({
    onSuccess: (res) => {
      notify.ok(`تم ترحيل قيد اليومية رقم #${res.journalId} بنجاح بمبلغ ${fmtAr(res.amount)} د.ع`);
      setClientRequestId(crypto.randomUUID());
      navigate("/journal");
    },
    onError: (err) => {
      notify.err(err);
    },
  });

  const updateLine = (idx: number, patch: Partial<JournalLineForm>) => {
    setLines((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx]!, ...patch };
      return copy;
    });
  };

  const addLine = () => {
    setLines((prev) => [...prev, emptyLine()]);
  };

  const removeLine = (idx: number) => {
    if (lines.length <= 2) {
      notify.err("يجب أن يحتوي القيد على سطرين على الأقل (مدين ودائن)");
      return;
    }
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const canSubmit =
    totals.isBalanced &&
    notes.trim().length >= 5 &&
    lines.length >= 2 &&
    lines.every((l) => {
      const accId = Number(l.accountId);
      const acc = accountsMap.get(accId);
      if (!acc || !acc.isActive || !acc.systemRole || FORBIDDEN_MANUAL_JOURNAL_ROLES.has(acc.systemRole)) {
        return false;
      }
      const d = moneyInput(l.debit);
      const c = moneyInput(l.credit);
      const hasAmount = (d.gt(0) && c.equals(0)) || (c.gt(0) && d.equals(0));
      if (!hasAmount) return false;

      const isAR = acc.systemRole === "AR" || acc.systemRole === "ACCOUNTS_RECEIVABLE";
      const isAP = acc.systemRole === "AP" || acc.systemRole === "ACCOUNTS_PAYABLE";
      if (isAR && !l.customerId) return false;
      if (isAP && !l.supplierId) return false;

      return true;
    });

  const handleSubmit = () => {
    if (!notes.trim() || notes.trim().length < 5) {
      notify.err("يجب كتابة بيان للقيد لا يقل عن 5 أحرف يشرح سبب القيد");
      return;
    }
    if (!totals.isBalanced) {
      notify.err("القيد غير متوازن! إجمالي المدين يجب أن يساوي تماماً إجمالي الدائن");
      return;
    }
    if (lines.length < 2) {
      notify.err("القيد يجب أن يحتوي على سطرين على الأقل");
      return;
    }

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const acc = accountsMap.get(Number(l.accountId));
      if (!acc || !acc.isActive || !acc.systemRole) {
        notify.err(`السطر ${i + 1}: يرجى اختيار حساب مالي صالح ومؤهل للترحيل`);
        return;
      }
      if (FORBIDDEN_MANUAL_JOURNAL_ROLES.has(acc.systemRole)) {
        notify.err(`السطر ${i + 1}: الحساب "${acc.name}" من حسابات الرقابة التشغيلية المحظورة في القيود اليدوية`);
        return;
      }
      const isAR = acc.systemRole === "AR" || acc.systemRole === "ACCOUNTS_RECEIVABLE";
      const isAP = acc.systemRole === "AP" || acc.systemRole === "ACCOUNTS_PAYABLE";
      if (isAR && !l.customerId) {
        notify.err(`السطر ${i + 1}: حساب ذمم العملاء "${acc.name}" يتطلب تحديد العميل لإحكام المطابقة`);
        return;
      }
      if (isAP && !l.supplierId) {
        notify.err(`السطر ${i + 1}: حساب ذمم الموردين "${acc.name}" يتطلب تحديد المورد لإحكام المطابقة`);
        return;
      }
    }

    // تجهيز الأسطر للإرسال
    const payloadLines = lines.map((l) => {
      const accId = Number(l.accountId);
      const dVal = moneyInput(l.debit);
      const cVal = moneyInput(l.credit);
      const custId = l.customerId ? Number(l.customerId) : null;
      const suppId = l.supplierId ? Number(l.supplierId) : null;

      return {
        accountId: accId,
        debit: dVal.toFixed(2),
        credit: cVal.toFixed(2),
        customerId: custId,
        supplierId: suppId,
      };
    });

    createMutation.mutate({
      clientRequestId,
      entryDate,
      branchId: branchId ? Number(branchId) : null,
      notes: notes.trim(),
      lines: payloadLines,
    });
  };

  // تفعيل اختصار حفظ النماذج المعتمد (Ctrl+S)
  useSaveShortcuts({
    onSave: () => {
      if (canSubmit && !createMutation.isPending) {
        handleSubmit();
      }
    },
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto p-4 md:p-6" dir="rtl">
      <PageHeader
        title="قيد يومية يدوي جديد"
        description="تسجيل قيد محاسبي مزدوج ومتوازن وترحيله مباشرة للأستاذ العام ودفاتر الذمم المساعدة"
        backHref="/journal"
        backLabel="سجل القيود"
        actions={
          <div className="flex items-center gap-2">
            <Link href="/journal">
              <Button variant="outline" size="sm">
                إلغاء
              </Button>
            </Link>
            <Button
              size="sm"
              disabled={!canSubmit || createMutation.isPending}
              onClick={handleSubmit}
            >
              {createMutation.isPending ? ACTION_LABELS.saving : "ترحيل وحفظ القيد"}
            </Button>
          </div>
        }
      />

      {/* بطاقة معلومات القيد العامة */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="size-4 text-primary" />
            بيانات القيد والتاريخ
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5">
                <Calendar className="size-4 text-muted-foreground" />
                تاريخ القيد
                <span className="text-destructive">*</span>
              </label>
              <Input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="w-full text-right"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5">
                <Building2 className="size-4 text-muted-foreground" />
                الفرع (اختياري)
              </label>
              <AppSelect
                value={branchId}
                onValueChange={setBranchId}
                className="w-full text-right"
              >
                <option value="">جميع الفروع / المركز الرئيسي</option>
                {branches.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name} ({b.code})
                  </option>
                ))}
              </AppSelect>
            </div>

            <div className="sm:col-span-2 md:col-span-3 space-y-1.5">
              <label className="text-sm font-medium">
                البيان العام للقيد (سبب التسوية المحاسبية)
                <span className="text-destructive">*</span>
              </label>
              <Textarea
                placeholder="مثال: إثبات مصاريف ضيافة نقدية للفرع أو تسوية ذمة عميل..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full text-right resize-none"
              />
              <span className="text-xs text-muted-foreground">
                الحد الأدنى 5 أحرف توضح طبيعة العملية لأغراض التدقيق المالي.
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* بطاقة أسطر القيد المحاسبي */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Scale className="size-4 text-primary" />
            أسطر القيد المزدوج (مدين / دائن)
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addLine}
            className="flex items-center gap-1"
          >
            <Plus className="size-4" />
            إضافة سطر
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {lines.map((line, idx) => {
            const selectedAcc = line.accountId ? accountsMap.get(Number(line.accountId)) : null;
            const isAR = selectedAcc?.systemRole === "AR" || selectedAcc?.systemRole === "ACCOUNTS_RECEIVABLE";
            const isAP = selectedAcc?.systemRole === "AP" || selectedAcc?.systemRole === "ACCOUNTS_PAYABLE";

            return (
              <div
                key={line.id}
                className="p-3 border rounded-lg bg-card/60 space-y-3 relative group"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-12 gap-3 items-center">
                  {/* رقم السطر واختيار الحساب المؤهل للترحيل اليدوي */}
                  <div className="md:col-span-5 space-y-1">
                    <label className="text-xs font-semibold text-muted-foreground">
                      السطر {idx + 1}: الحساب المالي
                      <span className="text-destructive">*</span>
                    </label>
                    <AppSelect
                      value={line.accountId}
                      onValueChange={(val) => updateLine(idx, { accountId: val })}
                      className="w-full text-right"
                    >
                      <option value="">-- اختر الحساب من الدليل --</option>
                      {postableAccounts.map((acc) => (
                        <option key={acc.id} value={String(acc.id)}>
                          {acc.code} - {acc.name} ({acc.type})
                        </option>
                      ))}
                    </AppSelect>
                  </div>

                  {/* مبلغ المدين */}
                  <div className="md:col-span-3 space-y-1">
                    <label className="text-xs font-semibold text-money-positive">
                      مدين (Debit)
                    </label>
                    <MoneyInput
                      value={line.debit}
                      onChange={(val) => {
                        // تفريغ الدائن إن كان هناك مدين لسهولة وسرعة الإدخال
                        const patch: Partial<JournalLineForm> = { debit: val };
                        if (val && val !== "0") patch.credit = "";
                        updateLine(idx, patch);
                      }}
                      placeholder="0.00"
                      className="text-start font-mono"
                    />
                  </div>

                  {/* مبلغ الدائن */}
                  <div className="md:col-span-3 space-y-1">
                    <label className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                      دائن (Credit)
                    </label>
                    <MoneyInput
                      value={line.credit}
                      onChange={(val) => {
                        // تفريغ المدين إن كان هناك دائن لسهولة وسرعة الإدخال
                        const patch: Partial<JournalLineForm> = { credit: val };
                        if (val && val !== "0") patch.debit = "";
                        updateLine(idx, patch);
                      }}
                      placeholder="0.00"
                      className="text-start font-mono"
                    />
                  </div>

                  {/* حذف السطر */}
                  <div className="md:col-span-1 flex items-end justify-center pt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeLine(idx)}
                      disabled={lines.length <= 2}
                      className="text-destructive hover:bg-destructive/10"
                      title="حذف هذا السطر"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {/* ربط الطرف المساعد الإلزامي لحسابات ذمم العملاء والموردين */}
                {(isAR || isAP) && (
                  <div className="pt-2 border-t grid grid-cols-1 sm:grid-cols-2 gap-3 bg-muted/20 p-2 rounded">
                    {isAR && (
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-destructive flex items-center gap-1">
                          العميل المرتبط بالذمة (إلزامي لدفتر أستاذ العملاء المساعد)
                          <span>*</span>
                        </label>
                        <AppSelect
                          value={line.customerId}
                          onValueChange={(val) => updateLine(idx, { customerId: val })}
                          className="w-full text-right text-xs"
                        >
                          <option value="">-- اختر العميل لإحكام المطابقة --</option>
                          {customers.map((c) => (
                            <option key={c.id} value={String(c.id)}>
                              {c.name} {c.phone ? `(${c.phone})` : ""}
                            </option>
                          ))}
                        </AppSelect>
                      </div>
                    )}
                    {isAP && (
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-destructive flex items-center gap-1">
                          المورد المرتبط بالذمة (إلزامي لدفتر أستاذ الموردين المساعد)
                          <span>*</span>
                        </label>
                        <AppSelect
                          value={line.supplierId}
                          onValueChange={(val) => updateLine(idx, { supplierId: val })}
                          className="w-full text-right text-xs"
                        >
                          <option value="">-- اختر المورد لإحكام المطابقة --</option>
                          {suppliers.map((s) => (
                            <option key={s.id} value={String(s.id)}>
                              {s.name}
                            </option>
                          ))}
                        </AppSelect>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* بطاقة الرقابة والتحقق من توازن القيد (Balance Monitor) */}
      <Card className="border-2 border-primary/20">
        <CardContent className="p-4 md:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-center">
            {/* إجمالي المدين */}
            <div className="p-3 bg-muted/40 border rounded-lg text-center space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">
                إجمالي المدين (Total Debit)
              </span>
              <div className="text-lg md:text-xl font-bold font-mono text-money-positive">
                {fmtAr(totals.debit.toFixed(2))} د.ع
              </div>
            </div>

            {/* إجمالي الدائن */}
            <div className="p-3 bg-muted/40 border rounded-lg text-center space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">
                إجمالي الدائن (Total Credit)
              </span>
              <div className="text-lg md:text-xl font-bold font-mono text-primary">
                {fmtAr(totals.credit.toFixed(2))} د.ع
              </div>
            </div>

            {/* حالة التوازن والفرق */}
            <div
              className={`p-3 border rounded-lg text-center space-y-1 ${
                totals.isBalanced
                  ? "bg-primary/10 border-primary/40 text-primary"
                  : "bg-destructive/10 border-destructive/40 text-destructive"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 text-xs font-semibold">
                {totals.isBalanced ? (
                  <>
                    <CheckCircle2 className="size-4 text-primary" />
                    <span>القيد متوازن تماماً</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="size-4" />
                    <span>فارق عدم التوازن</span>
                  </>
                )}
              </div>
              <div className="text-lg md:text-xl font-bold font-mono">
                {totals.isBalanced ? "0.00 د.ع" : `${fmtAr(totals.difference.toFixed(2))} د.ع`}
              </div>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              {totals.isBalanced ? (
                <span className="text-money-positive font-medium flex items-center gap-1">
                  <CheckCircle2 className="size-3.5" />
                  الأطراف متكافئة محاسبياً والقيد جاهز للترحيل الدائم.
                </span>
              ) : (
                <span className="text-destructive font-medium flex items-center gap-1">
                  <AlertCircle className="size-3.5" />
                  لا يمكن ترحيل قيد غير متوازن وفق الأصول المحاسبية الصارمة.
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setNotes("");
                  setLines([emptyLine(), emptyLine()]);
                }}
              >
                تفريغ الحقول
              </Button>
              <Button
                type="button"
                disabled={!canSubmit || createMutation.isPending}
                onClick={handleSubmit}
                className="min-w-36"
              >
                {createMutation.isPending ? ACTION_LABELS.saving : "ترحيل وحفظ القيد"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
