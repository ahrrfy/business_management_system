import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { FileText, Plus, Trash2 } from "lucide-react";

const DOC_TYPE_LABELS: Record<string, string> = {
  PASSPORT: "جواز سفر",
  RESIDENCY_VISA: "إقامة عمالة",
  WORK_PERMIT: "إجازة عمل",
  NATIONAL_ID: "بطاقة وطنية",
  HEALTH_CERTIFICATE: "شهادة صحية",
  EDUCATION_CERTIFICATE: "وثيقة دراسية",
  CONTRACT_SCAN: "نسخة عقد",
  OTHER: "مستند آخر",
};

export function EmployeeDocumentsTab({ employeeId }: { employeeId: number }) {
  const utils = trpc.useUtils();
  const q = trpc.hrEnterprise.documents.list.useQuery({ employeeId });
  const [open, setOpen] = useState(false);

  const [docType, setDocType] = useState<string>("RESIDENCY_VISA");
  const [title, setTitle] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [alertDaysBefore, setAlertDaysBefore] = useState("30");
  const [notes, setNotes] = useState("");

  const createMut = trpc.hrEnterprise.documents.add.useMutation({
    onSuccess: async () => {
      notify.ok("تمت إضافة المستند بنجاح");
      setOpen(false);
      setTitle("");
      setDocumentNumber("");
      setNotes("");
      await utils.hrEnterprise.documents.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const delMut = trpc.hrEnterprise.documents.delete.useMutation({
    onSuccess: async () => {
      notify.ok("تم حذف المستند بنجاح");
      await utils.hrEnterprise.documents.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      notify.err("يرجى إدخال عنوان المستند");
      return;
    }
    createMut.mutate({
      employeeId,
      documentType: docType as any,
      title: title.trim(),
      documentNumber: documentNumber.trim() || undefined,
      issueDate: issueDate || undefined,
      expiryDate: expiryDate || undefined,
      alertDaysBefore: Number(alertDaysBefore) || 30,
      notes: notes.trim() || undefined,
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-active">ساري</span>;
      case "EXPIRING_SOON":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[var(--sem-warn)]/10 text-[var(--sem-warn)] border border-[var(--sem-warn)]/30">ينتهي قريبا</span>;
      case "EXPIRED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-cancelled">منتهي الصلاحية</span>;
      default:
        return <span>{status}</span>;
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            المستندات والوثائق الرسمية
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            إدارة الجوازات والإقامات وإجازات العمل والفحوصات مع تنبيهات الصلاحية التلقائية.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          إضافة مستند
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {q.isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">جاري تحميل المستندات...</div>
        ) : !q.data || q.data.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            لا توجد مستندات مسجلة لهذا الموظف حتى الآن.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>نوع المستند</TableHead>
                <TableHead>العنوان</TableHead>
                <TableHead>رقم المستند</TableHead>
                <TableHead>تاريخ الإصدار</TableHead>
                <TableHead>تاريخ الانتهاء</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead>ملاحظات</TableHead>
                <TableHead className="w-16">إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium text-xs">
                    {DOC_TYPE_LABELS[doc.documentType] ?? doc.documentType}
                  </TableCell>
                  <TableCell>{doc.title}</TableCell>
                  <TableCell dir="ltr" className="text-start font-mono text-xs">
                    {doc.documentNumber || "—"}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start text-xs">
                    {fmtDate(doc.issueDate)}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start text-xs">
                    {fmtDate(doc.expiryDate)}
                  </TableCell>
                  <TableCell>{getStatusBadge(doc.status)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {doc.notes || "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10"
                      disabled={delMut.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          variant: "danger",
                          title: "حذف المستند",
                          description: `هل أنت متأكد من حذف المستند «${doc.title}»؟`,
                          confirmText: "حذف",
                        });
                        if (ok) delMut.mutate({ id: doc.id });
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>إضافة مستند رسمي جديد</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor="doc-type">نوع المستند</Label>
                <AppSelect id="doc-type" value={docType} onValueChange={setDocType}>
                  <option value="RESIDENCY_VISA">إقامة عمالة أجنبية</option>
                  <option value="PASSPORT">جواز سفر</option>
                  <option value="WORK_PERMIT">إجازة عمل رسمية</option>
                  <option value="NATIONAL_ID">بطاقة وطنية / هوية</option>
                  <option value="HEALTH_CERTIFICATE">شهادة فحص طبي</option>
                  <option value="EDUCATION_CERTIFICATE">وثيقة تخرج / مؤهل</option>
                  <option value="CONTRACT_SCAN">نسخة العقد الورقي الموقعة</option>
                  <option value="OTHER">مستند رسمي آخر</option>
                </AppSelect>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="doc-title">عنوان المستند</Label>
                <Input
                  id="doc-title"
                  placeholder="مثال: إقامة العمل لسنة 2026"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="doc-no">رقم المستند / المعاملة</Label>
                <Input
                  id="doc-no"
                  placeholder="رقم الجواز أو المعاملة"
                  value={documentNumber}
                  onChange={(e) => setDocumentNumber(e.target.value)}
                  dir="ltr"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="doc-issue">تاريخ الإصدار</Label>
                  <Input
                    id="doc-issue"
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="doc-expiry">تاريخ الانتهاء</Label>
                  <Input
                    id="doc-expiry"
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="doc-alert-days">أيام التنبيه المسبق قبل الانتهاء</Label>
                <Input
                  id="doc-alert-days"
                  type="number"
                  min="1"
                  max="180"
                  value={alertDaysBefore}
                  onChange={(e) => setAlertDaysBefore(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="doc-notes">ملاحظات إضافية</Label>
                <Textarea
                  id="doc-notes"
                  placeholder="ملاحظات حول جهة الإصدار أو جهة الحفظ"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "جاري الحفظ..." : "حفظ المستند"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
