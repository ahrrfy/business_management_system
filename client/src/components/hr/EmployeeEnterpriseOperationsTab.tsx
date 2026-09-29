import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ArrowRightLeft, Award, Calculator, CheckCircle, Coins, Plus, XCircle } from "lucide-react";

export function EmployeeEnterpriseOperationsTab({
  employeeId,
  branchId,
  basicSalary,
  allowances,
  annualLeaveBalance,
  currentUserId,
}: {
  employeeId: number;
  branchId?: number;
  basicSalary?: string | number | null;
  allowances?: string | number | null;
  annualLeaveBalance?: number | null;
  currentUserId?: number;
}) {
  const utils = trpc.useUtils();
  const [subTab, setSubTab] = useState("loans");

  // Queries
  const loansQ = trpc.hrEnterprise.loans.list.useQuery({ employeeId });
  const transfersQ = trpc.hrEnterprise.transfers.list.useQuery({ employeeId });
  const spotBonusesQ = trpc.hrEnterprise.spotBonuses.list.useQuery({ employeeId });
  const leaveEncashmentQ = trpc.hrEnterprise.leaveEncashment.preview.useQuery({ employeeId });

  // Modal Dialogs
  const [openLoan, setOpenLoan] = useState(false);
  const [openTransfer, setOpenTransfer] = useState(false);
  const [openSpotBonus, setOpenSpotBonus] = useState(false);

  // Loan State
  const [loanAmount, setLoanAmount] = useState("");
  const [loanInstallments, setLoanInstallments] = useState("3");
  const [loanReason, setLoanReason] = useState("");

  // Transfer State
  const [toBranchId, setToBranchId] = useState<string>("");
  const [toDepartment, setToDepartment] = useState("");
  const [toPosition, setToPosition] = useState("");
  const [transferDate, setTransferDate] = useState(new Date().toISOString().slice(0, 10));
  const [transferEffectiveDate, setTransferEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [transferDecisionNo, setTransferDecisionNo] = useState("");
  const [transferReason, setTransferReason] = useState("");

  // Spot Bonus State
  const [bonusAmount, setBonusAmount] = useState("");
  const [bonusReason, setBonusReason] = useState("");
  const [bonusDecisionNo, setBonusDecisionNo] = useState("");
  const [bonusDisbursementType, setBonusDisbursementType] = useState<"CASH_TREASURY" | "PAYROLL_ADDITION">("CASH_TREASURY");

  // Mutations
  const createLoanMut = trpc.hrEnterprise.loans.request.useMutation({
    onSuccess: async () => {
      notify.ok("تم رفع طلب السلفة بنجاح وهو بانتظار المراجعة والاعتماد");
      setOpenLoan(false);
      setLoanAmount("");
      setLoanReason("");
      await utils.hrEnterprise.loans.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const reviewLoanMut = trpc.hrEnterprise.loans.review.useMutation({
    onSuccess: async () => {
      notify.ok("تم تحديث حالة طلب السلفة بنجاح");
      await utils.hrEnterprise.loans.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const disburseLoanMut = trpc.hrEnterprise.loans.disburse.useMutation({
    onSuccess: async () => {
      notify.ok("تم صرف السلفة وتوليد سجل السلفة النشط في النظام المالي");
      await utils.hrEnterprise.loans.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const createTransferMut = trpc.hrEnterprise.transfers.request.useMutation({
    onSuccess: async () => {
      notify.ok("تم تسجيل قرار النقل بنجاح وهو بانتظار الاعتماد");
      setOpenTransfer(false);
      setTransferDecisionNo("");
      setTransferReason("");
      await utils.hrEnterprise.transfers.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const approveTransferMut = trpc.hrEnterprise.transfers.approve.useMutation({
    onSuccess: async () => {
      notify.ok("تم اعتماد قرار النقل، وسيتم تحديث فرع وقسم الموظف تلقائياً عند حلول تاريخ النفاذ");
      await utils.hrEnterprise.transfers.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const createBonusMut = trpc.hrEnterprise.spotBonuses.create.useMutation({
    onSuccess: async () => {
      notify.ok("تم تسجيل المكافأة الفورية بنجاح");
      setOpenSpotBonus(false);
      setBonusAmount("");
      setBonusReason("");
      await utils.hrEnterprise.spotBonuses.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const approveBonusMut = trpc.hrEnterprise.spotBonuses.approve.useMutation({
    onSuccess: async () => {
      notify.ok("تم اعتماد المكافأة الفورية");
      await utils.hrEnterprise.spotBonuses.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">العمليات الإدارية والمالية المؤسسية</CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          السلف الذاتية، التنقلات الإدارية بين الفروع، المكافآت الاستثنائية، وحساب تعويض الإجازات المتراكمة.
        </p>
      </CardHeader>
      <CardContent>
        <Tabs value={subTab} onValueChange={setSubTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="loans" className="gap-1.5">
              <Coins className="h-3.5 w-3.5" />
              طلبات السلف
            </TabsTrigger>
            <TabsTrigger value="transfers" className="gap-1.5">
              <ArrowRightLeft className="h-3.5 w-3.5" />
              التنقلات الإدارية
            </TabsTrigger>
            <TabsTrigger value="bonuses" className="gap-1.5">
              <Award className="h-3.5 w-3.5" />
              المكافآت الفورية
            </TabsTrigger>
            <TabsTrigger value="leaveEncashment" className="gap-1.5">
              <Calculator className="h-3.5 w-3.5" />
              تعويض الإجازات (المادة 77)
            </TabsTrigger>
          </TabsList>

          {/* Sub-tab 1: Loans */}
          <TabsContent value="loans" className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                المادة 51: لا يجوز أن يزيد إجمالي الاستقطاع الشهري للسداد عن 20% من راتب الموظف الأساسي.
              </span>
              <Button size="sm" onClick={() => setOpenLoan(true)} className="gap-1">
                <Plus className="h-3.5 w-3.5" />
                طلب سلفة
              </Button>
            </div>

            {loansQ.isLoading ? (
              <div className="p-6 text-center text-xs text-muted-foreground">جاري تحميل السلف...</div>
            ) : !loansQ.data || loansQ.data.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">لا توجد طلبات سلف مسجلة.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>مبلغ السلفة</TableHead>
                    <TableHead>الأقساط</TableHead>
                    <TableHead>القسط الشهري</TableHead>
                    <TableHead>السبب</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead className="w-32">إجراء</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loansQ.data.map((loan) => (
                    <TableRow key={loan.id}>
                      <TableCell dir="ltr" className="text-start tabular-nums font-medium text-xs">
                        {iqd(loan.amount)}
                      </TableCell>
                      <TableCell className="tabular-nums text-xs">{loan.installmentsCount} شهر</TableCell>
                      <TableCell dir="ltr" className="text-start tabular-nums text-xs">
                        {iqd(loan.monthlyDeduction)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">
                        {loan.reason || "—"}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs">{loan.status}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {loan.status === "PENDING" && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-primary"
                                disabled={reviewLoanMut.isPending}
                                onClick={() => reviewLoanMut.mutate({ id: loan.id, action: "APPROVE" })}
                              >
                                موافقة
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-destructive"
                                disabled={reviewLoanMut.isPending}
                                onClick={() => reviewLoanMut.mutate({ id: loan.id, action: "REJECT", rejectionReason: "تم الرفض من الإدارة" })}
                              >
                                رفض
                              </Button>
                            </>
                          )}
                          {loan.status === "APPROVED" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={disburseLoanMut.isPending}
                              onClick={async () => {
                                const ok = await confirm({
                                  variant: "warning",
                                  title: "صرف السلفة",
                                  description: `صرف سلفة بمبلغ ${iqd(loan.amount)}؟ سيتم تسجيل استحقاق السلفة وتفعيل استقطاعها شهرياً.`,
                                  confirmText: "صرف",
                                });
                                if (ok) disburseLoanMut.mutate({ id: loan.id });
                              }}
                            >
                              صرف وتفعيل
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          {/* Sub-tab 2: Transfers */}
          <TabsContent value="transfers" className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                توثيق حركة التنقلات بين الفروع والأقسام مع حفظ كامل الأرشيف الوظيفي.
              </span>
              <Button size="sm" onClick={() => setOpenTransfer(true)} className="gap-1">
                <Plus className="h-3.5 w-3.5" />
                تسجيل قرار نقل
              </Button>
            </div>

            {transfersQ.isLoading ? (
              <div className="p-6 text-center text-xs text-muted-foreground">جاري تحميل التنقلات...</div>
            ) : !transfersQ.data || transfersQ.data.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">لا توجد تنقلات مسجلة للموظف.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>رقم القرار</TableHead>
                    <TableHead>تاريخ النقل</TableHead>
                    <TableHead>تاريخ النفاذ</TableHead>
                    <TableHead>القسم الجديد</TableHead>
                    <TableHead>المسمى الجديد</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead className="w-24">إجراء</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transfersQ.data.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell dir="ltr" className="text-start font-mono text-xs">{t.decisionNumber}</TableCell>
                      <TableCell dir="ltr" className="text-start text-xs">{fmtDate(t.transferDate)}</TableCell>
                      <TableCell dir="ltr" className="text-start text-xs">{fmtDate(t.effectiveDate)}</TableCell>
                      <TableCell className="text-xs">{t.toDepartment || "—"}</TableCell>
                      <TableCell className="text-xs">{t.toPosition || "—"}</TableCell>
                      <TableCell><span className="text-xs">{t.status}</span></TableCell>
                      <TableCell>
                        {t.status === "PENDING" && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-primary"
                              disabled={approveTransferMut.isPending}
                              onClick={() => approveTransferMut.mutate({ id: t.id })}
                            >
                              اعتماد
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          {/* Sub-tab 3: Spot Bonuses */}
          <TabsContent value="bonuses" className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                المكافآت الفورية الاستثنائية للتميز أو الإنجازات الخاصة.
              </span>
              <Button size="sm" onClick={() => setOpenSpotBonus(true)} className="gap-1">
                <Plus className="h-3.5 w-3.5" />
                منح مكافأة فورية
              </Button>
            </div>

            {spotBonusesQ.isLoading ? (
              <div className="p-6 text-center text-xs text-muted-foreground">جاري تحميل المكافآت...</div>
            ) : !spotBonusesQ.data || spotBonusesQ.data.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">لا توجد مكافآت مسجلة.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>المبلغ</TableHead>
                    <TableHead>سبب المكافأة</TableHead>
                    <TableHead>طريقة الصرف</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead className="w-24">إجراء</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {spotBonusesQ.data.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell dir="ltr" className="text-start tabular-nums font-medium text-xs">
                        {iqd(b.amount)}
                      </TableCell>
                      <TableCell className="text-xs">{b.reason}</TableCell>
                      <TableCell className="text-xs">
                        {b.disbursementType === "CASH_TREASURY" ? "سند صرف خزينة" : "إضافة لمسير الراتب"}
                      </TableCell>
                      <TableCell><span className="text-xs">{b.status}</span></TableCell>
                      <TableCell>
                        {b.status === "DRAFT" && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-primary"
                              disabled={approveBonusMut.isPending}
                              onClick={() => approveBonusMut.mutate({ id: b.id })}
                            >
                              اعتماد
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          {/* Sub-tab 4: Leave Encashment Calculator */}
          <TabsContent value="leaveEncashment" className="space-y-4">
            <div className="p-4 rounded-md border border-border bg-muted/30 space-y-3">
              <div className="font-semibold text-sm">
                حساب بدل الإجازات السنوية المستحقة (المادة 77 من قانون العمل رقم 37 لسنة 2015)
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                يستحق العامل عند انتهاء خدمته تعويضاً نقدياً عن كامل رصيد إجازاته السنوية غير المستعملة محسوباً على أساس آخر أجر شهري تقاضاه مقسوماً على 30.
              </p>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
                <div className="p-3 rounded border bg-background text-center">
                  <div className="text-xs text-muted-foreground">الراتب الشهري الإجمالي</div>
                  <div className="text-sm font-bold tabular-nums mt-1" dir="ltr">
                    {iqd(Number(basicSalary ?? 0) + Number(allowances ?? 0))}
                  </div>
                </div>

                <div className="p-3 rounded border bg-background text-center">
                  <div className="text-xs text-muted-foreground">معدل الأجر اليومي (÷ 30)</div>
                  <div className="text-sm font-bold tabular-nums mt-1 text-primary" dir="ltr">
                    {iqd(leaveEncashmentQ.data?.dailyWage ?? 0)}
                  </div>
                </div>

                <div className="p-3 rounded border bg-background text-center">
                  <div className="text-xs text-muted-foreground">رصيد الإجازات المتبقي</div>
                  <div className="text-sm font-bold tabular-nums mt-1">
                    {annualLeaveBalance ?? 0} يوم
                  </div>
                </div>

                <div className="p-3 rounded border bg-background text-center border-primary/40">
                  <div className="text-xs text-muted-foreground">إجمالي التعويض المستحق</div>
                  <div className="text-base font-bold tabular-nums mt-1 text-primary" dir="ltr">
                    {iqd(leaveEncashmentQ.data?.encashmentAmount ?? 0)}
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>

      {/* Loan Request Dialog */}
      <Dialog open={openLoan} onOpenChange={setOpenLoan}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!loanAmount || Number(loanAmount) <= 0) {
                notify.err("يرجى إدخال مبلغ سلفة صحيح");
                return;
              }
              const installments = Number(loanInstallments) || 1;
              const monthly = Math.ceil(Number(loanAmount) / installments);
              const maxLegal = Number(basicSalary ?? 0) * 0.2;
              if (maxLegal > 0 && monthly > maxLegal) {
                notify.err(`القسط الشهري (${iqd(monthly)}) يتجاوز السقف القانوني (20% = ${iqd(maxLegal)})`);
                return;
              }
              createLoanMut.mutate({
                employeeId,
                amount: loanAmount,
                installmentsCount: installments,
                monthlyDeduction: String(monthly),
                reason: loanReason.trim() || undefined,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>تقديم طلب سلفة جديدة للموظف</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor="loan-amt">مبلغ السلفة المطلوب (د.ع)</Label>
                <MoneyInput
                  id="loan-amt"
                  placeholder="500,000"
                  value={loanAmount}
                  onChange={setLoanAmount}
                  decimals={0}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="loan-inst">عدد أشهر السداد (الأقساط)</Label>
                <Input
                  id="loan-inst"
                  type="number"
                  min="1"
                  max="24"
                  value={loanInstallments}
                  onChange={(e) => setLoanInstallments(e.target.value)}
                  required
                />
              </div>

              {Number(loanAmount) > 0 && (
                <div className="p-2.5 rounded bg-muted text-xs flex justify-between">
                  <span>القسط الشهري المقدر:</span>
                  <span className="font-bold tabular-nums" dir="ltr">
                    {iqd(Math.ceil(Number(loanAmount) / (Number(loanInstallments) || 1)))}
                  </span>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="loan-reason">سبب السلفة</Label>
                <Textarea
                  id="loan-reason"
                  placeholder="ظرف طارئ، علاج، مصاريف..."
                  value={loanReason}
                  onChange={(e) => setLoanReason(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpenLoan(false)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={createLoanMut.isPending}>
                {createLoanMut.isPending ? "جاري الإرسال..." : "إرسال الطلب"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Transfer Dialog */}
      <Dialog open={openTransfer} onOpenChange={setOpenTransfer}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!transferDecisionNo.trim()) {
                notify.err("يرجى إدخال رقم القرار الإداري");
                return;
              }
              createTransferMut.mutate({
                employeeId,
                toBranchId: toBranchId ? Number(toBranchId) : undefined,
                toDepartment: toDepartment.trim() || undefined,
                toPosition: toPosition.trim() || undefined,
                decisionNumber: transferDecisionNo.trim(),
                transferDate,
                effectiveDate: transferEffectiveDate,
                reason: transferReason.trim() || undefined,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>تسجيل قرار نقل إداري</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor="transfer-dec">رقم القرار الإداري</Label>
                <Input
                  id="transfer-dec"
                  placeholder="مثال: TRF-2026-05"
                  value={transferDecisionNo}
                  onChange={(e) => setTransferDecisionNo(e.target.value)}
                  dir="ltr"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="trf-date">تاريخ القرار</Label>
                  <Input
                    id="trf-date"
                    type="date"
                    value={transferDate}
                    onChange={(e) => setTransferDate(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="trf-eff">تاريخ النفاذ</Label>
                  <Input
                    id="trf-eff"
                    type="date"
                    value={transferEffectiveDate}
                    onChange={(e) => setTransferEffectiveDate(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="to-dept">القسم الجديد</Label>
                  <Input
                    id="to-dept"
                    placeholder="مثال: الحسابات"
                    value={toDepartment}
                    onChange={(e) => setToDepartment(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="to-pos">المسمى الجديد</Label>
                  <Input
                    id="to-pos"
                    placeholder="مثال: محاسب فرع"
                    value={toPosition}
                    onChange={(e) => setToPosition(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="trf-reason">أسباب ومبررات النقل</Label>
                <Textarea
                  id="trf-reason"
                  placeholder="حاجة العمل، تدوير وظيفي..."
                  value={transferReason}
                  onChange={(e) => setTransferReason(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpenTransfer(false)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={createTransferMut.isPending}>
                {createTransferMut.isPending ? "جاري الحفظ..." : "تسجيل القرار"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Spot Bonus Dialog */}
      <Dialog open={openSpotBonus} onOpenChange={setOpenSpotBonus}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!bonusAmount || Number(bonusAmount) <= 0 || !bonusReason.trim()) {
                notify.err("يرجى إدخال مبلغ وسبب المكافأة");
                return;
              }
              createBonusMut.mutate({
                employeeId,
                amount: bonusAmount,
                reason: bonusReason.trim(),
                decisionNumber: bonusDecisionNo.trim() || undefined,
                disbursementType: bonusDisbursementType,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>منح مكافأة فورية استثنائية</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor="bonus-amt">مبلغ المكافأة (د.ع)</Label>
                <MoneyInput
                  id="bonus-amt"
                  placeholder="150,000"
                  value={bonusAmount}
                  onChange={setBonusAmount}
                  decimals={0}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bonus-disb">قناة الصرف</Label>
                <AppSelect
                  id="bonus-disb"
                  value={bonusDisbursementType}
                  onValueChange={(v: any) => setBonusDisbursementType(v)}
                >
                  <option value="CASH_TREASURY">سند صرف مباشر من الخزينة (صندوق الفرع)</option>
                  <option value="PAYROLL_ADDITION">إضافة لبند مكافآت مسير الرواتب الشهري</option>
                </AppSelect>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bonus-dec">رقم كتاب الشكر والتقدير / القرار</Label>
                <Input
                  id="bonus-dec"
                  placeholder="مثال: APP-2026-11"
                  value={bonusDecisionNo}
                  onChange={(e) => setBonusDecisionNo(e.target.value)}
                  dir="ltr"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bonus-rsn">سبب الاستحقاق والإنجاز</Label>
                <Textarea
                  id="bonus-rsn"
                  placeholder="جهود استثنائية في إتمام الجرد، تحقيق مستهدف قياسي..."
                  value={bonusReason}
                  onChange={(e) => setBonusReason(e.target.value)}
                  rows={2}
                  required
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpenSpotBonus(false)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={createBonusMut.isPending}>
                {createBonusMut.isPending ? "جاري الحفظ..." : "تسجيل المكافأة"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
