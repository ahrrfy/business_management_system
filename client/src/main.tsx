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

const queryClient = new QueryClient();

function handleUnauthorized(error: unknown) {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;
  if (error.message !== UNAUTHED_ERR_MSG) return;
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

// حوكمة تحديث PWA: registerType:'prompt' لا يُطبّق SW الجديد صامتاً.
// نَعرض شارة «إصدار جديد» للمستخدم، وهو يَختار وقت التحديث ⇒ يَمنع استبدال الحزمة في وسط معاملة حسّاسة.
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  void import("virtual:pwa-register").then(({ registerSW }) => {
    const updateSW = registerSW({
      onNeedRefresh() {
        toast.info("يَتوفّر إصدار جديد من النظام", {
          description: "اضغط «تحديث» لتطبيق آخر إصدار. عملك الحالي سيُحفظ ثم تُعاد الواجهة.",
          duration: Infinity,
          action: {
            label: "تحديث",
            onClick: () => {
              void updateSW(true);
            },
          },
        });
      },
      onOfflineReady() {
        toast.success("النظام جاهز للعمل دون اتصال");
      },
    });
  }).catch(() => {
    // virtual:pwa-register غير متاح في dev بلا plugin؛ صامت.
  });
}
