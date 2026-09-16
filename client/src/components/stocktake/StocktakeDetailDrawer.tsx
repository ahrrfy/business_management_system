import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmtInt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Layers,
  MapPin,
  ShieldAlert,
  User,
  Users,
} from "lucide-react";
import { Link } from "wouter";

interface StocktakeDetailDrawerProps {
  sessionId: number | null;
  onClose: () => void;
  isManagerPlus?: boolean;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  COUNTING: { label: "قيد العدّ", cls: "badge-status-pending" },
  REVIEW: { label: "قيد المراجعة", cls: "badge-stock-low" },
  APPROVED: { label: "معتمدة ومُسوّاة", cls: "badge-status-active" },
  CANCELLED: { label: "ملغاة", cls: "badge-stock-out" },
};

const SCOPE_TYPE_LABEL: Record<string, string> = {
  FULL: "جرد شامل للفرع",
  MOVING: "المنتجات المتحركة",
  CATEGORY: "حسب الفئة",
  MANUAL: "منتجات مختارة",
};

export function StocktakeDetailDrawer({
  sessionId,
  onClose,
  isManagerPlus,
}: StocktakeDetailDrawerProps) {
  const query = trpc.stocktakes.get.useQuery(
    { sessionId: sessionId! },
    { enabled: !!sessionId },
  );

  const data = query.data;
  const session = data?.session;
  const assignments = data?.assignments ?? [];
  const progress = data?.progress ?? { total: 0, counted: 0 };
  const pct = Math.round(
    (progress.counted / Math.max(progress.total, 1)) * 100,
  );

  return (
    <Sheet open={!!sessionId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="left"
        className="w-full sm:max-w-xl md:max-w-2xl overflow-y-auto p-0 flex flex-col"
        dir="rtl"
      >
        <SheetHeader className="p-6 pb-4 border-b bg-card sticky top-0 z-10">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <SheetTitle className="text-xl font-bold tracking-tight">
                {session ? session.name : "تفاصيل جلسة الجرد"}
              </SheetTitle>
              {session?.code ? (
                <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                  {session.code}
                </span>
              ) : null}
            </div>
            {session?.status ? (
              <Badge
                variant="outline"
                className={STATUS_BADGE[session.status]?.cls ?? ""}
              >
                {STATUS_BADGE[session.status]?.label ?? session.status}
              </Badge>
            ) : null}
          </div>
        </SheetHeader>

        <div className="p-6 space-y-6 flex-1">
          {query.isLoading ? (
            <LoadingState message="جارٍ تحميل تفاصيل الجلسة..." />
          ) : query.isError ? (
            <ErrorState
              message={query.error?.message ?? "خطأ في تحميل تفاصيل الجلسة"}
            />
          ) : !session ? (
            <p className="text-center text-muted-foreground py-8">
              لا توجد بيانات لهذه الجلسة.
            </p>
          ) : (
            <>
              {/* شريط التقدم السريع */}
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold flex items-center gap-1.5">
                      <Layers className="h-4 w-4 text-primary" />
                      إجمالي تقدم العدّ
                    </span>
                    <span className="text-sm font-mono font-bold text-primary">
                      {fmtInt(progress.counted)} / {fmtInt(progress.total)} (
                      {pct}%)
                    </span>
                  </div>
                  <Progress value={pct} className="h-2.5" />
                </CardContent>
              </Card>

              {/* البيانات العامة */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border p-3 bg-muted/20">
                  <span className="text-xs text-muted-foreground block mb-1">
                    الفرع والنطاق
                  </span>
                  <p className="font-semibold text-foreground flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                    {session.branchName}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {SCOPE_TYPE_LABEL[session.scopeType] ?? session.scopeType}
                    {session.scopeLabel ? ` (${session.scopeLabel})` : ""}
                  </p>
                </div>

                <div className="rounded-lg border p-3 bg-muted/20">
                  <span className="text-xs text-muted-foreground block mb-1">
                    المنشئ والنوع
                  </span>
                  <p className="font-semibold text-foreground flex items-center gap-1">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    {session.createdByName}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    تاريخ الإنشاء: {fmtDate(session.createdAt)}
                  </p>
                </div>
              </div>

              {/* تواريخ التدقيق والاعتماد */}
              {(session.submittedAt || session.firstSign || session.approved) && (
                <div className="rounded-lg border p-3.5 space-y-2 bg-muted/10 text-xs">
                  <span className="font-semibold text-muted-foreground block">
                    سجل التوقيعات والاعتماد:
                  </span>
                  {session.submittedAt ? (
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" /> تم إرسال العدّ:
                      </span>
                      <span>{fmtDateTime(session.submittedAt)}</span>
                    </div>
                  ) : null}
                  {session.firstSign ? (
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5 text-[var(--sem-info)]" />{" "}
                        التوقيع الأول ({session.firstSign.byName}):
                      </span>
                      <span>
                        {session.firstSign.at
                          ? fmtDateTime(session.firstSign.at)
                          : "—"}
                      </span>
                    </div>
                  ) : null}
                  {session.approved ? (
                    <div className="flex items-center justify-between font-medium text-[var(--pos-success)]">
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" /> الاعتماد النهائي
                        ({session.approved.byName}):
                      </span>
                      <span>
                        {session.approved.at
                          ? fmtDateTime(session.approved.at)
                          : "—"}
                      </span>
                    </div>
                  ) : null}
                </div>
              )}

              {/* عمال الجرد والتكليفات */}
              <div className="space-y-2.5">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4 text-primary" />
                  فرق وعمال الجرد المكلفون ({assignments.length})
                </h4>
                {assignments.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center border rounded-lg">
                    لا يوجد عمال مكلفون مسجلون.
                  </p>
                ) : (
                  <div className="border rounded-lg divide-y text-xs">
                    {assignments.map((a: any) => {
                      const aPct = a.total > 0 ? Math.round((a.counted / a.total) * 100) : null;
                      return (
                        <div
                          key={a.id}
                          className="p-3 flex items-center justify-between gap-3"
                        >
                          <div>
                            <p className="font-semibold text-foreground">
                              {a.name}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {a.method === "USER"
                                ? "حساب نظام"
                                : "رمز PIN للجرد"}
                              {a.zone ? ` · النطاق: ${a.zone}` : ""}
                            </p>
                          </div>
                          <div className="text-left">
                            <span className="font-mono font-medium">
                              {fmtInt(a.counted)} {a.total > 0 ? `/ ${fmtInt(a.total)}` : "مادة معدودة"}
                            </span>
                            {aPct != null && (
                              <span className="text-[11px] text-muted-foreground mr-2">
                                ({aPct}%)
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* معايير الحوكمة وحدود الفروقات */}
              {isManagerPlus && (
                <div className="border rounded-lg p-3.5 bg-muted/20 space-y-2 text-xs">
                  <h4 className="font-semibold flex items-center gap-1.5 text-foreground">
                    <ShieldAlert className="h-3.5 w-3.5 text-primary" />
                    معايير الحوكمة وحدود التدقيق
                  </h4>
                  <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                    <div>
                      نسبة العتبة:{" "}
                      <span className="font-mono font-bold text-foreground">
                        {session.thresholdPct}%
                      </span>
                    </div>
                    <div>
                      قيمة العتبة:{" "}
                      <span className="font-mono font-bold text-foreground">
                        {session.thresholdValue} د.ع
                      </span>
                    </div>
                    <div>
                      عتبة التوقيع المزدوج:{" "}
                      <span className="font-mono font-bold text-foreground">
                        {session.dualThreshold} د.ع
                      </span>
                    </div>
                    <div>
                      سياسة التكرار:{" "}
                      <span className="font-bold text-foreground">
                        {session.dupPolicy === "BLOCK" ? "منع" : "تحقق وتنبيه"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* ملاحظات الجلسة إن وجدت */}
              {session.notes && (
                <div className="border rounded-lg p-3 bg-muted/10 text-xs">
                  <span className="font-semibold block mb-1 text-muted-foreground">
                    ملاحظات:
                  </span>
                  <p className="text-foreground whitespace-pre-line">
                    {session.notes}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* أزرار الإجراءات السريعة في الأسفل */}
        {session && (
          <div className="p-4 border-t bg-card sticky bottom-0 z-10 flex flex-wrap gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              إغلاق
            </Button>

            <Link href={`/stocktakes/${session.id}`}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" />
                شاشة المتابعة الحية
              </Button>
            </Link>

            {session.status === "COUNTING" && (
              <Link href={session.code ? `/count/${session.code}` : "/my-stocktake"}>
                <Button variant="outline" size="sm" className="gap-1.5">
                  بوابة العد الميداني
                </Button>
              </Link>
            )}

            {session.status === "REVIEW" && isManagerPlus && (
              <Link href={`/stocktakes/${session.id}/review`}>
                <Button size="sm" className="gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  المراجعة والاعتماد
                </Button>
              </Link>
            )}

            {session.status === "APPROVED" && isManagerPlus && (
              <Link href={`/stocktakes/${session.id}/report`}>
                <Button size="sm" className="gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  تقرير التسوية المعتمد
                </Button>
              </Link>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
