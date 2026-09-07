import { useState, useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtDate } from "@/lib/date";
import { ROLES } from "@shared/permissions";
import {
  BellRing,
  Plus,
  Search,
  Radio,
  Eye,
  CheckCircle2,
  Clock,
  Building2,
  ShieldAlert,
  Users,
  AlertTriangle,
  RotateCcw,
  CheckCheck,
} from "lucide-react";

type AnnouncementPriority = "NORMAL" | "IMPORTANT" | "CRITICAL";
type AnnouncementAudienceType = "ALL" | "BRANCH" | "ROLE";

interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  priority: AnnouncementPriority;
  audienceType: AnnouncementAudienceType;
  audienceBranchId: number | null;
  audienceRole: string | null;
  requiresAck: boolean;
  isActive: boolean;
  createdAt: string | Date;
  expiresAt: string | Date | null;
  readCount: number;
  ackCount: number;
}

export default function Announcements() {
  const utils = trpc.useUtils();
  const [includeInactive, setIncludeInactive] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("ALL");
  const [audienceFilter, setAudienceFilter] = useState("ALL");

  // نوافذ الحوار
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [readersModalId, setReadersModalId] = useState<number | null>(null);

  // حقول نموذج إنشاء إعلان جديد
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<AnnouncementPriority>("IMPORTANT");
  const [audienceType, setAudienceType] = useState<AnnouncementAudienceType>("ALL");
  const [audienceBranchId, setAudienceBranchId] = useState<string>("");
  const [audienceRole, setAudienceRole] = useState<string>("");
  const [requiresAck, setRequiresAck] = useState(false);
  const [expiresAtDate, setExpiresAtDate] = useState<string>("");

  // استعلام الفروع
  const branchesQuery = trpc.branches.list.useQuery();
  const branches = branchesQuery.data || [];

  // استعلام الإعلانات الإداري
  const announcementsQuery = trpc.announcements.list.useQuery(
    { includeInactive },
    { refetchOnWindowFocus: false },
  );

  // استعلام تفاصيل القراء للإعلان المحدد
  const readersQuery = trpc.announcements.get.useQuery(
    { id: readersModalId || 1 },
    { enabled: Boolean(readersModalId) },
  );

  // إجراء النشر
  const createMutation = trpc.announcements.create.useMutation({
    onSuccess: () => {
      notify.ok("تم نشر الإعلان الإداري بنجاح وتعميمه");
      setCreateDialogOpen(false);
      resetForm();
      utils.announcements.list.invalidate();
      utils.announcements.mine.invalidate();
    },
    onError: (err) => {
      notify.err(err.message || "فشل نشر الإعلان");
    },
  });

  // إجراء التفعيل والتعطيل
  const toggleActiveMutation = trpc.announcements.setActive.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث حالة الإعلان بنجاح");
      utils.announcements.list.invalidate();
      utils.announcements.mine.invalidate();
    },
    onError: (err) => {
      notify.err(err.message || "فشل تغيير حالة الإعلان");
    },
  });

  const resetForm = () => {
    setTitle("");
    setBody("");
    setPriority("IMPORTANT");
    setAudienceType("ALL");
    setAudienceBranchId("");
    setAudienceRole("");
    setRequiresAck(false);
    setExpiresAtDate("");
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      notify.err("يرجى إدخال عنوان الإعلان");
      return;
    }
    if (!body.trim()) {
      notify.err("يرجى إدخال نص وتفاصيل الإعلان");
      return;
    }
    if (audienceType === "BRANCH" && !audienceBranchId) {
      notify.err("يرجى تحديد الفرع المستهدف للإعلان");
      return;
    }
    if (audienceType === "ROLE" && !audienceRole) {
      notify.err("يرجى تحديد الدور الوظيفي المستهدف");
      return;
    }

    let parsedExpires: string | undefined = undefined;
    if (expiresAtDate) {
      const d = new Date(expiresAtDate + "T23:59:59.999Z");
      if (d.getTime() <= Date.now()) {
        notify.err("تاريخ الانتهاء يجب أن يكون في المستقبل");
        return;
      }
      parsedExpires = d.toISOString();
    }

    createMutation.mutate({
      title: title.trim(),
      body: body.trim(),
      priority,
      audienceType,
      audienceBranchId: audienceType === "BRANCH" ? Number(audienceBranchId) : null,
      audienceRole: audienceType === "ROLE" ? audienceRole : null,
      requiresAck,
      expiresAt: parsedExpires,
    });
  };

  const rawRows = (announcementsQuery.data || []) as AnnouncementRow[];

  // تصفية البيانات
  const filteredRows = useMemo(() => {
    return rawRows.filter((item) => {
      if (priorityFilter !== "ALL" && item.priority !== priorityFilter) {
        return false;
      }
      if (audienceFilter !== "ALL" && item.audienceType !== audienceFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = item.title.toLowerCase().includes(q);
        const matchesBody = item.body.toLowerCase().includes(q);
        if (!matchesTitle && !matchesBody) return false;
      }
      return true;
    });
  }, [rawRows, priorityFilter, audienceFilter, searchQuery]);

  // المؤشرات العلوية
  const activeCount = rawRows.filter((r) => r.isActive).length;
  const totalReads = rawRows.reduce((acc, r) => acc + (r.readCount || 0), 0);
  const totalAcks = rawRows.reduce((acc, r) => acc + (r.ackCount || 0), 0);
  const criticalCount = rawRows.filter((r) => r.isActive && r.priority === "CRITICAL").length;

  const branchMap = useMemo(() => {
    return new Map<number, string>(branches.map((b) => [b.id, b.name]));
  }, [branches]);

  const roleMap = useMemo(() => {
    return new Map<string, string>(ROLES.map((r) => [r.key, r.label]));
  }, []);

  const columns: ColumnDef<AnnouncementRow>[] = [
    {
      id: "priority",
      header: "مستوى الأولوية",
      cell: ({ row }) => {
        const item = row.original;
        if (item.priority === "CRITICAL") {
          return (
            <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive font-bold">
              <ShieldAlert className="size-3 me-1" aria-hidden />
              عاجل وطارئ
            </Badge>
          );
        }
        if (item.priority === "IMPORTANT") {
          return (
            <Badge variant="outline" className="border-stock-low/30 bg-stock-low/10 text-stock-low font-bold">
              <AlertTriangle className="size-3 me-1" aria-hidden />
              توجيه إداري
            </Badge>
          );
        }
        return (
          <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary font-medium">
            <Radio className="size-3 me-1" aria-hidden />
            إعلان داخلي
          </Badge>
        );
      },
    },
    {
      id: "title",
      header: "عنوان الإعلان والتفاصيل",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="max-w-md space-y-1 text-start">
            <div className="font-semibold text-sm text-foreground flex items-center gap-2">
              <span>{item.title}</span>
              {item.requiresAck && (
                <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0 border">
                  إقرار إلزامي
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {item.body}
            </p>
          </div>
        );
      },
    },
    {
      id: "audienceType",
      header: "الجمهور المستهدف",
      cell: ({ row }) => {
        const item = row.original;
        if (item.audienceType === "ALL") {
          return (
            <span className="inline-flex items-center gap-1 text-xs text-foreground font-medium">
              <Users className="size-3.5 text-muted-foreground" aria-hidden />
              كافة الموظفين والفروع
            </span>
          );
        }
        if (item.audienceType === "BRANCH") {
          const bName = (item.audienceBranchId && branchMap.get(item.audienceBranchId)) || `فرع رقم ${item.audienceBranchId}`;
          return (
            <span className="inline-flex items-center gap-1 text-xs text-foreground font-medium">
              <Building2 className="size-3.5 text-muted-foreground" aria-hidden />
              {bName}
            </span>
          );
        }
        const rName = (item.audienceRole && roleMap.get(item.audienceRole)) || item.audienceRole || "دور مخصص";
        return (
          <span className="inline-flex items-center gap-1 text-xs text-foreground font-medium">
            <Users className="size-3.5 text-muted-foreground" aria-hidden />
            {rName}
          </span>
        );
      },
    },
    {
      id: "createdAt",
      header: "تاريخ النشر والانتهاء",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="text-xs space-y-0.5 text-muted-foreground">
            <div>نُشر: {fmtDate(item.createdAt)}</div>
            {item.expiresAt ? (
              <div className="flex items-center gap-1 text-[11px]">
                <Clock className="size-3 text-muted-foreground" aria-hidden />
                ينتهي: {fmtDate(item.expiresAt)}
              </div>
            ) : (
              <div className="text-[11px]">صلاحية دائمة</div>
            )}
          </div>
        );
      },
    },
    {
      id: "readCount",
      header: "القراءات والإقرارات",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="text-xs space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Eye className="size-3.5 text-primary" aria-hidden />
              <span>{item.readCount.toLocaleString("ar-IQ-u-nu-latn")} قراءة</span>
            </div>
            {item.requiresAck && (
              <div className="flex items-center gap-1.5 font-medium text-money-positive">
                <CheckCheck className="size-3.5 text-money-positive" aria-hidden />
                <span>{item.ackCount.toLocaleString("ar-IQ-u-nu-latn")} إقرار</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "isActive",
      header: "الحالة",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex items-center gap-2">
            <Switch
              checked={item.isActive}
              disabled={toggleActiveMutation.isPending}
              onCheckedChange={(checked) => {
                toggleActiveMutation.mutate({ id: item.id, isActive: checked });
              }}
              aria-label="تفعيل أو تعطيل الإعلان"
            />
            <span className="text-xs font-medium text-muted-foreground">
              {item.isActive ? "نشط" : "معطل"}
            </span>
          </div>
        );
      },
    },
    {
      id: "id",
      header: "الإجراءات",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReadersModalId(item.id)}
            className="h-8 text-xs font-medium"
          >
            <Eye className="size-3.5 me-1 text-primary" aria-hidden />
            سجل القراء
          </Button>
        );
      },
    },
  ];

  return (
    <div className="space-y-6" dir="rtl">
      <PageHeader
        title="إدارة ونشر إعلانات الشركة"
        description="بث التوجيهات الإدارية، إعلانات الفروع، وتتبع إقرارات وقراءات الكوادر"
        breadcrumbs={[
          { label: "الرئيسية", href: "/" },
          { label: "الإعلانات والتوجيهات" },
        ]}
        actions={
          <Button
            type="button"
            onClick={() => setCreateDialogOpen(true)}
            className="font-bold flex items-center gap-2"
          >
            <Plus className="size-4" aria-hidden />
            <span>نشر إعلان جديد</span>
          </Button>
        }
      />

      {/* بطاقات المؤشرات العلوية */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
              <span>الإعلانات النشطة</span>
              <BellRing className="size-4 text-primary" aria-hidden />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-foreground">
              {activeCount.toLocaleString("ar-IQ-u-nu-latn")}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              من إجمالي {rawRows.length.toLocaleString("ar-IQ-u-nu-latn")} إعلاناً مسجلاً
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
              <span>توجيهات عاجلة وطارئة</span>
              <ShieldAlert className="size-4 text-destructive" aria-hidden />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-destructive">
              {criticalCount.toLocaleString("ar-IQ-u-nu-latn")}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              تظهر في صدارة شريط السبتلايت
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
              <span>إجمالي القراءات</span>
              <Eye className="size-4 text-primary" aria-hidden />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-foreground">
              {totalReads.toLocaleString("ar-IQ-u-nu-latn")}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              اطلاع موثق من حسابات الكوادر
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
              <span>الإقرارات الرسمية بالعلم</span>
              <CheckCircle2 className="size-4 text-money-positive" aria-hidden />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-money-positive">
              {totalAcks.toLocaleString("ar-IQ-u-nu-latn")}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              إقرار رقمي معتمد بالنظام
            </p>
          </CardContent>
        </Card>
      </div>

      {/* شريط البحث والتصفية */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row items-center gap-3">
            <div className="relative flex-1 w-full">
              <Search className="absolute start-3 top-2.5 size-4 text-muted-foreground pointer-events-none" aria-hidden />
              <Input
                type="text"
                placeholder="البحث في عناوين ونصوص الإعلانات…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ps-9"
              />
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto">
              <div className="w-40">
                <AppSelect
                  value={priorityFilter}
                  onValueChange={setPriorityFilter}
                  placeholder="كل الأولويات"
                >
                  <option value="ALL">كل الأولويات</option>
                  <option value="CRITICAL">عاجل وطارئ</option>
                  <option value="IMPORTANT">توجيه إداري</option>
                  <option value="NORMAL">إعلان داخلي</option>
                </AppSelect>
              </div>

              <div className="w-44">
                <AppSelect
                  value={audienceFilter}
                  onValueChange={setAudienceFilter}
                  placeholder="كل الجماهير"
                >
                  <option value="ALL">كل المستهدفين</option>
                  <option value="ALL_USERS">كافة الفروع والموظفين</option>
                  <option value="BRANCH">فروع محددة</option>
                  <option value="ROLE">أدوار وظيفية</option>
                </AppSelect>
              </div>

              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium whitespace-nowrap bg-muted/30">
                <Switch
                  id="includeInactiveSwitch"
                  checked={includeInactive}
                  onCheckedChange={setIncludeInactive}
                />
                <Label htmlFor="includeInactiveSwitch" className="cursor-pointer text-xs">
                  عرض المؤرشف
                </Label>
              </div>

              {(searchQuery || priorityFilter !== "ALL" || audienceFilter !== "ALL") && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchQuery("");
                    setPriorityFilter("ALL");
                    setAudienceFilter("ALL");
                  }}
                  className="h-9 px-2 text-xs"
                >
                  <RotateCcw className="size-3.5 me-1" aria-hidden />
                  إعادة تعيين
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* جدول الإعلانات */}
      <Card>
        <CardContent className="p-0">
          <DataTable<AnnouncementRow>
            columns={columns}
            data={filteredRows}
            searchable={false}
            loading={announcementsQuery.isLoading}
            errorState={{
              isError: announcementsQuery.isError,
              message: announcementsQuery.error?.message,
              onRetry: () => void announcementsQuery.refetch(),
            }}
            emptyText="لا توجد إعلانات إدارية مسجلة بعد — يمكنك نشر أول إعلان عبر الزر أعلاه."
          />
        </CardContent>
      </Card>

      {/* نافذة إنشاء إعلان جديد */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>نشر إعلان وتوجيه إداري جديد</DialogTitle>
            <DialogDescription>
              يتم بث هذا الإعلان في شريط السبتلايت الإخباري وفي لوحة الموظفين المستهدفين فوراً.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateSubmit} className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="announcementTitle" className="text-xs font-semibold">
                عنوان الإعلان <span className="text-destructive">*</span>
              </Label>
              <Input
                id="announcementTitle"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="مثال: تنبيه بخصوص موعد الجرد الدوري وجاهزية الفروع"
                required
                dir="auto"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="announcementBody" className="text-xs font-semibold">
                نص وتفاصيل الإعلان <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="announcementBody"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="اكتب التوجيه الإداري والتعليمات بالتفصيل هنا…"
                rows={4}
                required
                dir="auto"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">مستوى الأولوية</Label>
                <AppSelect
                  value={priority}
                  onValueChange={(val) => setPriority(val as AnnouncementPriority)}
                >
                  <option value="CRITICAL">عاجل وطارئ (تنبيه بارز فوري)</option>
                  <option value="IMPORTANT">توجيه إداري هام</option>
                  <option value="NORMAL">إعلان داخلي عام</option>
                </AppSelect>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">الجمهور المستهدف</Label>
                <AppSelect
                  value={audienceType}
                  onValueChange={(val) => {
                    setAudienceType(val as AnnouncementAudienceType);
                    setAudienceBranchId("");
                    setAudienceRole("");
                  }}
                >
                  <option value="ALL">كافة الفروع وكامل الكادر</option>
                  <option value="BRANCH">فرع محدد بعينه</option>
                  <option value="ROLE">دور وظيفي محدد</option>
                </AppSelect>
              </div>
            </div>

            {audienceType === "BRANCH" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">اختر الفرع المستهدف</Label>
                <AppSelect
                  value={audienceBranchId}
                  onValueChange={setAudienceBranchId}
                  placeholder="اختر الفرع…"
                >
                  <option value="">اختر الفرع…</option>
                  {branches.map((b) => (
                    <option key={b.id} value={String(b.id)}>
                      {b.name}
                    </option>
                  ))}
                </AppSelect>
              </div>
            )}

            {audienceType === "ROLE" && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">اختر الدور الوظيفي</Label>
                <AppSelect
                  value={audienceRole}
                  onValueChange={setAudienceRole}
                  placeholder="اختر الدور…"
                >
                  <option value="">اختر الدور الوظيفي…</option>
                  {ROLES.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </AppSelect>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <div className="space-y-1.5">
                <Label htmlFor="announcementExpiry" className="text-xs font-semibold">
                  تاريخ انتهاء الصلاحية (اختياري)
                </Label>
                <Input
                  id="announcementExpiry"
                  type="date"
                  value={expiresAtDate}
                  onChange={(e) => setExpiresAtDate(e.target.value)}
                  dir="ltr"
                />
              </div>

              <div className="flex items-center gap-2 pt-6">
                <Switch
                  id="requiresAckSwitch"
                  checked={requiresAck}
                  onCheckedChange={setRequiresAck}
                />
                <Label htmlFor="requiresAckSwitch" className="text-xs cursor-pointer">
                  إلزام الموظف بالإقرار بالعلم
                </Label>
              </div>
            </div>

            <DialogFooter className="gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateDialogOpen(false)}
              >
                إلغاء
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending}
                className="font-bold"
              >
                {createMutation.isPending ? "جارٍ النشر والتعميم…" : "نشر الإعلان فوراً"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* نافذة سجل القراء والإقرارات */}
      <Dialog
        open={Boolean(readersModalId)}
        onOpenChange={(open) => {
          if (!open) setReadersModalId(null);
        }}
      >
        <DialogContent className="max-w-md sm:max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="size-5 text-primary" aria-hidden />
              <span>سجل اطلاع وإقرارات الموظفين</span>
            </DialogTitle>
            <DialogDescription>
              {readersQuery.data?.announcement.title || "تفاصيل قراءة وتأكيد الإعلان"}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto space-y-2 py-2">
            {readersQuery.isLoading ? (
              <div className="text-center py-6 text-xs text-muted-foreground">
                جارٍ تحميل سجل القراء…
              </div>
            ) : !readersQuery.data?.readers || readersQuery.data.readers.length === 0 ? (
              <div className="text-center py-8 text-xs text-muted-foreground">
                لم يطّلع أي موظف على هذا الإعلان حتى الآن.
              </div>
            ) : (
              readersQuery.data.readers.map((reader) => (
                <div
                  key={reader.userId}
                  className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/20 text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="font-semibold text-foreground">
                      {reader.userName || `الموظف رقم ${reader.userId}`}
                    </div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <Clock className="size-3" aria-hidden />
                      قرأ في: {fmtDate(reader.readAt)}
                    </div>
                  </div>

                  <div>
                    {reader.acknowledgedAt ? (
                      <Badge variant="outline" className="border-money-positive/30 bg-money-positive/10 text-money-positive font-bold text-[11px]">
                        <CheckCircle2 className="size-3 me-1" aria-hidden />
                        أقر بالعلم ({fmtDate(reader.acknowledgedAt)})
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground text-[11px]">
                        لم يُقر بعد
                      </Badge>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReadersModalId(null)}
            >
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
