// نَتيجة Suspense للمسارات المُحمَّلة بـlazy(): شاشة مركزة بنفس نَصّ `Protected`
// كي يَبدو تَتابع التَحميل (chunk → auth check → الصفحة) سَلِساً بصرياً بلا قَفز.
// تَقصد أن تَكون خَفيفة جداً (تَدخل في الحزمة الأساسية).
export function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground">
      جارٍ التحميل…
    </div>
  );
}
