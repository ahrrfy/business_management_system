import { useState } from "react";
import { ShoppingBag, Monitor, CheckCircle2, Tag, User } from "lucide-react";
import { fmt, D } from "@/lib/money";
import { useCustomerFacingDisplay } from "@/lib/realtime";
import type { CustomerFacingDisplayUpdatedPayload } from "@shared/realtimeEvents";

export default function CustomerFacingDisplay() {
  const [data, setData] = useState<CustomerFacingDisplayUpdatedPayload | null>(null);

  useCustomerFacingDisplay((update) => {
    setData(update);
  });

  const lines = data?.lines ?? [];
  const hasItems = lines.length > 0;
  const total = data?.total ?? "0";
  const discount = data?.discount;
  const changeDue = data?.changeDue;
  const customerName = data?.customerName;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col justify-between p-6 select-none" dir="rtl">
      {/* الترويسة والشعار */}
      <header className="flex items-center justify-between border-b pb-4 mb-4" role="banner">
        <div className="flex items-center gap-3">
          <div aria-hidden="true" className="size-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-black text-xl shadow-xs">
            ع
          </div>
          <div>
            <div className="text-xl font-black tracking-tight">الرؤية العربية</div>
            <p className="text-xs text-muted-foreground font-medium">المكتبة والطباعة والقرطاسية — شاشة العميل</p>
          </div>
        </div>

        {customerName && (
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm font-bold text-primary" aria-label={`العميل: ${customerName}`}>
            <User aria-hidden className="size-4" />
            <span>العميل: {customerName}</span>
          </div>
        )}
      </header>

      {/* المحتوى الرئيسي: قائمة المشتريات */}
      <main className="flex-1 flex flex-col justify-center" role="main">
        {!hasItems ? (
          <div className="text-center py-16 space-y-4">
            <div className="size-20 mx-auto rounded-full bg-muted/50 flex items-center justify-center text-muted-foreground">
              <ShoppingBag aria-hidden className="size-10" />
            </div>
            <div className="space-y-1">
              <h2 className="text-2xl font-bold">أهلاً وسهلاً بكم</h2>
              <p className="text-sm text-muted-foreground">تفضّل باختيار مشترياتك وسنعرض تفاصيل الفاتورة هنا فوراً.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="max-h-[55vh] overflow-y-auto space-y-2 pe-1" role="list" aria-label="قائمة الأصناف المشتراة" aria-live="polite">
              {lines.map((line, idx) => (
                <div
                  key={`${line.name}_${idx}`}
                  role="listitem"
                  className="flex items-center justify-between p-3.5 rounded-lg border bg-card/60 shadow-2xs"
                >
                  <div className="space-y-0.5">
                    <span className="font-bold text-base">{line.name}</span>
                    <span className="text-xs text-muted-foreground block">
                      الكمية: {line.quantity} × {fmt(line.price)} د.ع
                    </span>
                  </div>
                  <span className="text-base font-black tabular-nums">
                    {fmt(D(line.price).mul(line.quantity).toString())} د.ع
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* الشريط السفلي: المجاميع والدفع */}
      <footer className="border-t pt-4 mt-4 space-y-3 bg-card/40 rounded-xl p-4 border" role="contentinfo" aria-label="ملخص الحساب والدفع">
        {discount && D(discount).gt(0) && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Tag aria-hidden className="size-4" /> الخصم الممنوح
            </span>
            <span className="font-bold text-destructive tabular-nums">-{fmt(discount)} د.ع</span>
          </div>
        )}

        <div className="flex items-center justify-between" aria-live="polite" aria-atomic="true">
          <span className="text-lg font-bold">المجموع الكلي المطلوب</span>
          <span className="text-3xl font-black text-primary tabular-nums">
            {fmt(total)} <span className="text-base font-bold">د.ع</span>
          </span>
        </div>

        {changeDue && D(changeDue).gt(0) && (
          <div className="flex items-center justify-between pt-2 border-t text-base font-bold text-money-positive" aria-live="polite" aria-atomic="true">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 aria-hidden className="size-5" /> المبلغ المتبقي (الباقي)
            </span>
            <span className="text-2xl font-black tabular-nums">
              {fmt(changeDue)} د.ع
            </span>
          </div>
        )}
      </footer>
    </div>
  );
}
