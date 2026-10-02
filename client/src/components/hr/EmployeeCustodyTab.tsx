import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Package, Plus, RotateCcw, ShieldAlert } from "lucide-react";

const CUSTODY_TYPE_LABELS: Record<string, string> = {
  TOOL: "أداة / عدد",
  DEVICE: "جهاز إلكتروني",
  VEHICLE: "مركبة / وسيلة نقل",
  KEY: "مفتاح / بطاقة وصول",
  DOCUMENT: "ملف / مستند رسمي",
  UNIFORM: "زي موحد / وقاية",
  OTHER: "عهدة أخرى",
};

export function EmployeeCustodyTab({ employeeId, branchId }: { employeeId: number; branchId?: number }) {
  const utils = trpc.useUtils();
  const q = trpc.hrEnterprise.custody.list.useQuery({ employeeId });
  const [openHandover, setOpenHandover] = useState(false);
  const [returnItem, setReturnItem] = useState<{ id: number; name: string } | null>(null);

  // Handover state
  const [itemType, setItemType] = useState<string>("TOOL");
  const [itemName, setItemName] = useState("");
  const [itemCode, setItemCode] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [conditionAtHandover, setConditionAtHandover] = useState("جيد جداً — بحالة المصنع");
  const [handoverDate, setHandoverDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedReturnDate, setExpectedReturnDate] = useState("");
  const [notes, setNotes] = useState("");

  // Return state
  const [returnCondition, setReturnCondition] = useState("جيد وسليم");
  const [returnStatus, setReturnStatus] = useState<"RETURNED" | "DAMAGED" | "LOST">("RETURNED");
  const [returnNotes, setReturnNotes] = useState("");

  const assignMut = trpc.hrEnterprise.custody.assign.useMutation({
    onSuccess: async () => {
      notify.ok("تم تسليم العهدة بنجاح وتوثيق الاستلام");
      setOpenHandover(false);
      setItemName("");
      setItemCode("");
      setSerialNumber("");
      setNotes("");
      await utils.hrEnterprise.custody.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const returnMut = trpc.hrEnterprise.custody.return.useMutation({
    onSuccess: async () => {
      notify.ok("تم استرجاع وتصفية العهدة بنجاح");
      setReturnItem(null);
      setReturnNotes("");
      await utils.hrEnterprise.custody.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const handleHandoverSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemName.trim()) {
      notify.err("يرجى كتابة اسم العهدة أو المعدة");
      return;
    }
    assignMut.mutate({
      employeeId,
      itemType: itemType as any,
      itemName: itemName.trim(),
      itemCode: itemCode.trim() || undefined,
      serialNumber: serialNumber.trim() || undefined,
      quantity: Number(quantity) || 1,
      conditionAtHandover: conditionAtHandover.trim() || undefined,
      handoverDate,
      expectedReturnDate: expectedReturnDate || undefined,
      notes: notes.trim() || undefined,
    });
  };

  const handleReturnSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnItem) return;
    returnMut.mutate({
      id: returnItem.id,
      actualReturnDate: new Date().toISOString().slice(0, 10),
      conditionAtReturn: returnCondition.trim() || undefined,
      status: returnStatus,
      returnNotes: returnNotes.trim() || undefined,
    });
  };

  const heldCount = q.data?.filter((c) => c.status === "HELD").length ?? 0;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "HELD":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[var(--sem-warn)]/10 text-[var(--sem-warn)] border border-[var(--sem-warn)]/30">في ذمة الموظف</span>;
      case "RETURNED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-active">مسترجعة بالكامل</span>;
      case "DAMAGED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-cancelled">تالفة</span>;
      case "LOST":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-cancelled">مفقودة</span>;
      default:
        return <span>{status}</span>;
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4 text-primary" />
            سجل العهد العينية والأدوات
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            حوكمة تسليم واسترجاع العهد والمعدات، وقفل براءة الذمة قبل إنهاء الخدمة لمنع التسريب.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpenHandover(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          تسليم عهدة جديدة
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {heldCount > 0 && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-[var(--sem-warn)]/10 border border-[var(--sem-warn)]/30 text-xs text-[var(--sem-warn)]">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>
              يوجد في ذمة الموظف حالياً ({heldCount}) عهدة معلقة. يمنع النظام منحه براءة ذمة نهائية عند إنهاء الخدمة حتى استرجاعها.
            </span>
          </div>
        )}

        {q.isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">جاري تحميل العهد...</div>
        ) : !q.data || q.data.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            لا توجد عهد عينية مسجلة لهذا الموظف.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>نوع العهدة</TableHead>
                <TableHead>اسم المادة / المعدة</TableHead>
                <TableHead>الرقم التسلسلي</TableHead>
                <TableHead>العدد</TableHead>
                <TableHead>تاريخ التسليم</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead className="w-24">إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium text-xs">
                    {CUSTODY_TYPE_LABELS[item.itemType] ?? item.itemType}
                  </TableCell>
                  <TableCell>{item.itemName}</TableCell>
                  <TableCell dir="ltr" className="text-start font-mono text-xs">
                    {item.serialNumber || item.itemCode || "—"}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs">{item.quantity}</TableCell>
                  <TableCell dir="ltr" className="text-start text-xs">
                    {fmtDate(item.handoverDate)}
                  </TableCell>
                  <TableCell>{getStatusBadge(item.status)}</TableCell>
                  <TableCell>
                    {item.status === "HELD" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => setReturnItem({ id: item.id, name: item.itemName })}
                      >
                        <RotateCcw className="h-3 w-3" />
                        استرجاع
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {/* Handover Dialog */}
      <Dialog open={openHandover} onOpenChange={setOpenHandover}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleHandoverSubmit}>
            <DialogHeader>
              <DialogTitle>تسليم عهدة عينية جديدة للموظف</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor="custody-type">نوع العهدة</Label>
                <AppSelect id="custody-type" value={itemType} onValueChange={setItemType}>
                  <option value="TOOL">أداة / عدد ورش أو تركيب</option>
                  <option value="DEVICE">لابتوب / حاسوب / جهاز ذكي</option>
                  <option value="VEHICLE">سيارة / دراجة نارية للشركة</option>
                  <option value="KEY">مفاتيح مقر / مستودع / بطاقة دخول</option>
                  <option value="DOCUMENT">ملفات رسمية / أختام معتمدة</option>
                  <option value="UNIFORM">زي الشركة / معدات السلامة المهنية</option>
                  <option value="OTHER">عهدة أخرى</option>
                </AppSelect>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="custody-name">اسم المادة / المعدة</Label>
                <Input
                  id="custody-name"
                  placeholder="مثال: لابتوب ديل للأعمال Dell Latitude"
                  value={itemName}
                  onChange={(e) => setItemName(e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="custody-code">كود المادة الداخلي</Label>
                  <Input
                    id="custody-code"
                    placeholder="مثال: AST-092"
                    value={itemCode}
                    onChange={(e) => setItemCode(e.target.value)}
                    dir="ltr"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="custody-serial">الرقم التسلسلي (S/N)</Label>
                  <Input
                    id="custody-serial"
                    placeholder="الرقم التسلسلي للجهاز"
                    value={serialNumber}
                    onChange={(e) => setSerialNumber(e.target.value)}
                    dir="ltr"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="custody-qty">الكمية المسلمة</Label>
                  <Input
                    id="custody-qty"
                    type="number"
                    min="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="custody-date">تاريخ التسليم</Label>
                  <Input
                    id="custody-date"
                    type="date"
                    value={handoverDate}
                    onChange={(e) => setHandoverDate(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="custody-condition">حالة المادة عند التسليم</Label>
                <Input
                  id="custody-condition"
                  value={conditionAtHandover}
                  onChange={(e) => setConditionAtHandover(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="custody-notes">ملاحظات إضافية</Label>
                <Textarea
                  id="custody-notes"
                  placeholder="تفاصيل الملحقات أو الكابلات المسلمة مع الجهاز"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpenHandover(false)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={assignMut.isPending}>
                {assignMut.isPending ? "جاري التسليم..." : "تسجيل وتثبيت العهدة"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Return Dialog */}
      <Dialog open={!!returnItem} onOpenChange={(o) => !o && setReturnItem(null)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleReturnSubmit}>
            <DialogHeader>
              <DialogTitle>استرجاع وتصفية عهدة: {returnItem?.name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor="return-status">حالة الاسترجاع</Label>
                <AppSelect id="return-status" value={returnStatus} onValueChange={(v: any) => setReturnStatus(v)}>
                  <option value="RETURNED">تم الاسترجاع بحالة سليمة</option>
                  <option value="DAMAGED">مسترجعة بحالة تالفة</option>
                  <option value="LOST">مفقودة / غير قابلة للاسترداد</option>
                </AppSelect>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="return-condition">فحص الحالة عند الاسترجاع</Label>
                <Input
                  id="return-condition"
                  placeholder="سليمة، تحتاج صيانة، الخ..."
                  value={returnCondition}
                  onChange={(e) => setReturnCondition(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="return-notes">ملاحظات الفحص والاستلام</Label>
                <Textarea
                  id="return-notes"
                  placeholder="ملاحظات أمين المخزن أو المشرف عند استلام العهدة"
                  value={returnNotes}
                  onChange={(e) => setReturnNotes(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setReturnItem(null)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={returnMut.isPending}>
                {returnMut.isPending ? "جاري التصفية..." : "تأكيد الاسترجاع وبراءة الذمة"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
