import { ConfirmHost } from "@/components/ConfirmHost";
import { Toaster } from "@/components/ui/sonner";
import { PwaUpdateManager } from "@/components/PwaUpdateManager";
import { InteractionDraftSafety } from "@/components/InteractionDraftSafety";
import { trpc } from "@/lib/trpc";
import { createErpTrpcClient } from "@/lib/trpcClient";
import { initConnectivity } from "@/lib/offline/connectivity";
import { applyStoredDisplayScale } from "@/lib/displayScale";
import { installGlobalInteractionAudio } from "@/lib/audioFeedback";
import { installDateTimeInputLocaleGuard } from "@/lib/dateTimeInputLocale";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { StorefrontBootstrap } from "./StorefrontBootstrap";
import "./index.css";
import "./styles/animate-subset.css";
import "./lib/theme/tokens.css";
import "./lib/theme/semantic-utilities.css";
import "./lib/theme/comfort.css";
import "./sentry";

applyStoredDisplayScale();
installGlobalInteractionAudio();
installDateTimeInputLocaleGuard();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (count, error) => {
        const status =
          error instanceof TRPCClientError ? error.data?.httpStatus : undefined;
        return (
          !(typeof status === "number" && status >= 400 && status < 500) &&
          count < 2
        );
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
    },
    mutations: { retry: false },
  },
});
initConnectivity({
  onBackOnline: () => {
    void queryClient.invalidateQueries();
  },
});
const client = createErpTrpcClient();
createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <StorefrontBootstrap />
        <InteractionDraftSafety />
        <PwaUpdateManager />
        <ConfirmHost />
        <Toaster richColors position="top-center" dir="rtl" />
      </ThemeProvider>
    </QueryClientProvider>
  </trpc.Provider>,
);
