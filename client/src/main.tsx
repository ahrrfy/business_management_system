import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmHost } from "@/components/ConfirmHost";
import { Toaster } from "@/components/ui/sonner";
import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import { toast } from "sonner";
import App from "./App";
// خط Cairo مستضاف محلياً (بلا اعتماد على Google Fonts CDN) ⇒ يعمل النظام كاملاً بلا إنترنت.
import "@fontsource/cairo/400.css";
import "@fontsource/cairo/500.css";
import "@fontsource/cairo/600.css";
import "@fontsource/cairo/700.css";
import "./index.css";
import "./lib/theme/tokens.css";
import "./sentry"; // مراقبة أخطاء العميل (لا أثر دون VITE_SENTRY_DSN_CLIENT)

// إعدادات عامة لكل استعلامات النظام (كانت `new QueryClient()` الخام ⇒ افتراضات v5:
// staleTime=0 + refetchOnWindowFocus + retry=3 بتراجع أُسّي). على VPS مشترك ببيانات
// حقيقية كان ذلك يُنتج «ثقلاً» وسبينر «جاري التحميل» متكرّراً عند كل عودة تركيز/تنقّل،
// و~٧ث تعليقاً على أخطاء الصلاحيات/التحقّق قبل ظهورها. الضبط أدناه يخدم التنقّل من الكاش
// ويُلغي عاصفة إعادة الجلب، بلا لمس أي صفحة (الصفحات التي تضبط خياراتها محلياً تبقى كما هي).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // طازج لدقيقة ⇒ التنقّل بين الشاشات والعودة إليها لا يُعيد الجلب من الصفر.
      staleTime: 60_000,
      // لا تُعِد الجلب لمجرّد عودة التركيز للنافذة (تبديل تبويب/رجوع من واتساب/إيصال).
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // لا تُعِد المحاولة على أخطاء 4xx (صلاحيات/تحقّق/مدخلات) — عقيمة وتُعلّق المستخدم؛
      // غيرها: محاولتان كحدّ أقصى بتراجع أُسّي مقصوص.
      retry: (count, err) => {
        if (err instanceof TRPCClientError) {
          const status = (err.data as { httpStatus?: number } | null | undefined)?.httpStatus;
          if (typeof status === "number" && status >= 400 && status < 500) return false;
        }
        return count < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
    },
  },
});

function handleUnauthorized(error: unknown) {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;
  // ٦/٧: المقارنة النصية القديمة (=== UNAUTHED_ERR_MSG) كانت كوداً ميتاً — errorFormatter
  // في server/trpc.ts يُعرّب كل الرسائل قبل وصولها فلا تتطابق أبداً، فيبقى المستخدم على
  // شاشة مليئة بالأخطاء حتى انتهاء staleTime. الشرط الآن: كود UNAUTHORIZED البنيوي +
  // رسالة «الجلسة منتهية» تحديداً (الإنجليزية الأصلية أو تعريبها العام) — لا نلمس
  // UNAUTHORIZED برسائل مخصّصة (كلمة مرور قديمة خاطئة/اعتماد مدير بالكاشير) وإلا طردنا
  // مستخدماً حيّاً من شاشته إلى الدخول.
  const code = (error.data as { code?: string } | null | undefined)?.code;
  const sessionGone =
    code === "UNAUTHORIZED" &&
    (error.message === UNAUTHED_ERR_MSG || error.message === "يجب تسجيل الدخول.");
  if (!sessionGone) return;
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    handleUnauthorized(event.query.state.error);
  }
});
queryClient.getMutationCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    handleUnauthorized(event.mutation.state.error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return fetch(input, { ...(init ?? {}), credentials: "include" });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <App />
        <CommandPalette />
        <ConfirmHost />
        <Toaster richColors position="top-center" dir="rtl" />
      </ThemeProvider>
    </QueryClientProvider>
  </trpc.Provider>
);

// حوكمة تحديث PWA: registerType:'autoUpdate' (انظر vite.config.ts). الـSW الجديد يَنشط فوراً
// (skipWaiting/clientsClaim) ويُنظّف الحُزَم القديمة، فيُعيد vite-plugin-pwa تحميل الصفحة تلقائياً
// عند اكتشاف نشر جديد ⇒ لا تبقى نسخة قديمة عالقة على «جار التحميل» بعد النشر. (كانت 'prompt'
// تُبقي المستخدم عالقاً قبل ظهور زرّ التحديث أصلاً.)
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  void import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({
      immediate: true,
      onOfflineReady() {
        toast.success("النظام جاهز للعمل دون اتصال");
      },
    });
  }).catch(() => {
    // virtual:pwa-register غير متاح في dev بلا plugin؛ صامت.
  });
}
