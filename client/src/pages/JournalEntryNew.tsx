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
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <div className="space-y-2.5 max-w-7xl mx-auto p-3 md:p-4" dir="rtl">
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
      <Card className="p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-12 gap-2.5 items-start">
          <div className="md:col-span-3 space-y-1">
            <label className="text-xs font-medium flex items-center gap-1">
              <Calendar className="size-3.5 text-muted-foreground" />
              تاريخ القيد <span className="text-destructive">*</span>
            </label>
            <Input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              className="h-8 w-full text-right text-xs"
            />
          </div>

          <div className="md:col-span-3 space-y-1">
            <label className="text-xs font-medium flex items-center gap-1">
              <Building2 className="size-3.5 text-muted-foreground" />
              الفرع (اختياري)
            </label>
            <AppSelect
              value={branchId}
              onValueChange={setBranchId}
              className="h-8 w-full text-right text-xs"
            >
              <option value="">جميع الفروع / المركز الرئيسي</option>
              {branches.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name} ({b.code})
                </option>
              ))}
            </AppSelect>
          </div>

          <div className="sm:col-span-2 md:col-span-6 space-y-1">
            <label className="text-xs font-medium" title="الحد الأدنى 5 أحرف توضح طبيعة العملية لأغراض التدقيق المالي.">
              البيان العام للقيد (سبب التسوية المحاسبية) <span className="text-destructive">*</span>
            </label>
            <Input
              placeholder="مثال: إثبات مصاريف ضيافة نقدية للفرع أو تسوية ذمة عميل (5 أحرف فأكثر)..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-8 w-full text-right text-xs"
            />
          </div>
        </div>
      </Card>

      {/* بطاقة أسطر القيد المحاسبي — جدول محاسبي مدمج بترويسة واحدة */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-3.5 py-2 bg-muted/20">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Scale className="size-3.5 text-primary" />
            <span>أسطر القيد المزدوج ({lines.length} سطر)</span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addLine}
            className="h-7 gap-1 text-xs"
          >
            <Plus className="size-3.5" />
            إضافة سطر
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table className="w-full text-xs">
            <TableHeader className="border-b bg-muted/40 text-muted-foreground">
              <TableRow>
                <TableHead className="w-10 px-2.5 py-1.5 text-center font-semibold">#</TableHead>
                <TableHead className="min-w-[240px] px-2.5 py-1.5 text-right font-semibold">
                  الحساب المالي <span className="text-destructive">*</span>
                </TableHead>
                <TableHead className="min-w-[200px] px-2.5 py-1.5 text-right font-semibold">
                  الطرف المساعد (عميل / مورد)
                </TableHead>
                <TableHead className="w-40 px-2.5 py-1.5 text-right font-semibold text-money-positive">
                  مدين (Debit)
                </TableHead>
                <TableHead className="w-40 px-2.5 py-1.5 text-right font-semibold text-primary">
                  دائن (Credit)
                </TableHead>
                <TableHead className="w-12 px-2 py-1.5 text-center font-semibold">حذف</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y">
              {lines.map((line, idx) => {
                const selectedAcc = line.accountId ? accountsMap.get(Number(line.accountId)) : null;
                const isAR = selectedAcc?.systemRole === "AR" || selectedAcc?.systemRole === "ACCOUNTS_RECEIVABLE";
                const isAP = selectedAcc?.systemRole === "AP" || selectedAcc?.systemRole === "ACCOUNTS_PAYABLE";

                return (
                  <TableRow key={line.id} className="hover:bg-muted/20">
                    <TableCell className="px-2.5 py-1.5 text-center font-mono text-muted-foreground">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="px-2.5 py-1.5">
                      <AppSelect
                        value={line.accountId}
                        searchable
                        searchPlaceholder="ابحث برمز الحساب أو اسمه..."
                        onValueChange={(val) => updateLine(idx, { accountId: val })}
                        className="h-8 w-full text-right text-xs"
                      >
                        <option value="">-- اختر الحساب من الدليل --</option>
                        {postableAccounts.map((acc) => (
                          <option key={acc.id} value={String(acc.id)}>
                            {acc.code} - {acc.name} ({acc.type})
                          </option>
                        ))}
                      </AppSelect>
                    </TableCell>
                    <TableCell className="px-2.5 py-1.5">
                      {isAR ? (
                        <AppSelect
                          value={line.customerId}
                          searchable
                          searchPlaceholder="ابحث عن العميل..."
                          onValueChange={(val) => updateLine(idx, { customerId: val })}
                          className="h-8 w-full text-right text-xs border-destructive/40"
                        >
                          <option value="">-- اختر العميل (إلزامي) * --</option>
                          {customers.map((c) => (
                            <option key={c.id} value={String(c.id)}>
                              {c.name} {c.phone ? `(${c.phone})` : ""}
                            </option>
                          ))}
                        </AppSelect>
                      ) : isAP ? (
                        <AppSelect
                          value={line.supplierId}
                          searchable
                          searchPlaceholder="ابحث عن المورد..."
                          onValueChange={(val) => updateLine(idx, { supplierId: val })}
                          className="h-8 w-full text-right text-xs border-destructive/40"
                        >
                          <option value="">-- اختر المورد (إلزامي) * --</option>
                          {suppliers.map((s) => (
                            <option key={s.id} value={String(s.id)}>
                              {s.name}
                            </option>
                          ))}
                        </AppSelect>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="px-2.5 py-1.5">
                      <MoneyInput
                        value={line.debit}
                        onChange={(val) => {
                          const patch: Partial<JournalLineForm> = { debit: val };
                          if (val && val !== "0") patch.credit = "";
                          updateLine(idx, patch);
                        }}
                        placeholder="0.00"
                        className="h-8 text-start font-mono text-xs"
                      />
                    </TableCell>
                    <TableCell className="px-2.5 py-1.5">
                      <MoneyInput
                        value={line.credit}
                        onChange={(val) => {
                          const patch: Partial<JournalLineForm> = { credit: val };
                          if (val && val !== "0") patch.debit = "";
                          updateLine(idx, patch);
                        }}
                        placeholder="0.00"
                        className="h-8 text-start font-mono text-xs"
                      />
                    </TableCell>
                    <TableCell className="px-2 py-1.5 text-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeLine(idx)}
                        disabled={lines.length <= 2}
                        className="size-7 text-destructive hover:bg-destructive/10"
                        title="حذف هذا السطر"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* شريط التوازن والإجراءات المدمج */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div>
              <span className="text-muted-foreground">إجمالي المدين: </span>
              <span className="font-bold font-mono text-money-positive" dir="ltr">
                {fmtAr(totals.debit.toFixed(2))} د.ع
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">إجمالي الدائن: </span>
              <span className="font-bold font-mono text-primary" dir="ltr">
                {fmtAr(totals.credit.toFixed(2))} د.ع
              </span>
            </div>
            <div
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold ${
                totals.isBalanced
                  ? "bg-primary/10 text-primary"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {totals.isBalanced ? (
                <>
                  <CheckCircle2 className="size-3.5" />
                  <span>القيد متوازن (0.00 د.ع)</span>
                </>
              ) : (
                <>
                  <AlertCircle className="size-3.5" />
                  <span>فارق عدم التوازن: {fmtAr(totals.difference.toFixed(2))} د.ع</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
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
              size="sm"
              disabled={!canSubmit || createMutation.isPending}
              onClick={handleSubmit}
            >
              {createMutation.isPending ? ACTION_LABELS.saving : "ترحيل وحفظ القيد"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
