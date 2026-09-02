import { ClipboardCheck, Clock3, Play, ScanLine } from "lucide-react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";

/**
 * مدخل الجرد للحسابات الداخلية. لا يعرض روابط PIN ولا أي بيانات عن العاملين
 * الآخرين؛ كل بطاقة هي تكليف USER عائد للحساب الحالي فقط.
 */
export default function MyStocktakes() {
  const mine = trpc.count.mine.useQuery(undefined, { refetchInterval: 30_000 });

  if (mine.isLoading)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        جارٍ تحميل مهام الجرد…
      </p>
    );
  if (mine.isError)
    return (
      <p className="p-8 text-sm text-destructive">
        تعذّر تحميل مهام الجرد. أعد المحاولة.
      </p>
    );
  const tasks = mine.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-1">
      {/* العنوان والوصف انتقلا إلى الرأس الموحّد؛ يبقى الشريط أدناه لِما لا يحمله الرأس:
          قناة العمل (حاسوب/هاتف) وعدّاد المهام المفتوحة — بنصّيهما حرفياً. */}
      <PageHeader
        title="جردي"
        description="افتح مهمتك من هنا بحسابك. لا تحتاج إلى رابط خارجي أو رمز PIN — ومن الهاتف يمكنك المسح بكاميرا الجهاز مباشرةً."
      />

      <section className="flex flex-col justify-between gap-4 rounded-2xl border bg-card p-6 shadow-sm md:flex-row md:items-center">
        <div className="flex items-center gap-2 text-primary">
          <ScanLine className="size-5" aria-hidden />
          <span className="text-sm font-bold">من الحاسوب أو الهاتف</span>
        </div>
        <div className="rounded-xl bg-primary/10 px-5 py-3 text-center text-primary">
          <div className="text-2xl font-bold tabular-nums">{tasks.length}</div>
          <div className="text-xs font-semibold">مهمة جرد مفتوحة</div>
        </div>
      </section>

      {tasks.length === 0 ? (
        <Card className="py-14 text-center">
          <CardContent className="flex flex-col items-center gap-3">
            <ClipboardCheck
              className="size-10 text-muted-foreground"
              aria-hidden
            />
            <div>
              <p className="font-bold">
                لا توجد مهمة جرد مسندة إلى حسابك حالياً
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                عند تكليفك، يختار المسؤول «حساب مستخدم داخل النظام» وستظهر
                المهمة هنا تلقائياً.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {tasks.map((task) => (
            <Card key={task.assignmentId} className="gap-4">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <ClipboardCheck className="size-5 text-primary" aria-hidden />
                  {task.sessionName}
                </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono" dir="ltr">
                    {task.sessionCode}
                  </span>
                  {task.zone ? (
                    <span>المنطقة: {task.zone}</span>
                  ) : (
                    <span>توجيه ميداني عام</span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock3 className="size-3.5" aria-hidden />
                  {task.assignmentStatus === "SUBMITTED"
                    ? "تم تسليم العدّ"
                    : "قيد العدّ"}
                </span>
                <Link
                  href={`/my-stocktake/${encodeURIComponent(task.sessionCode)}`}
                >
                  <Button>
                    <Play className="size-4" aria-hidden />
                    {task.assignmentStatus === "SUBMITTED"
                      ? "عرض المهمة"
                      : "فتح شاشة الجرد"}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
