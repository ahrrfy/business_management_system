import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * BeforeInstallPromptEvent — not part of the standard TS DOM lib yet (Chromium-only API).
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/**
 * Renders an "install as app" button when the browser fires `beforeinstallprompt`
 * (Chromium-only — Edge, Chrome, Brave, Opera). Hides itself in three cases:
 *  - the prompt event never fires (Safari, Firefox, or already-installed installs)
 *  - the app is already running in standalone display-mode (PWA already installed)
 *  - the user dismisses the prompt (we don't re-pester for the session)
 *
 * For store deployment, the bundled `تثبيت-الرؤية.bat` is the primary install path.
 * This button is the secondary path for users who open the cloud URL in a fresh browser
 * and want to "stick" the app to their taskbar without copying the ZIP.
 */
export function InstallAppButton() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Already installed — bail out.
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setEvt(null);

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!evt) return null;

  async function trigger() {
    if (!evt) return;
    setBusy(true);
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      if (choice.outcome !== "dismissed") setEvt(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      onClick={trigger}
      disabled={busy}
      size="sm"
      variant="outline"
      className="h-8 gap-1.5 text-xs"
      title="تثبيت النظام كتطبيق سطح مكتب"
    >
      <Download className="size-3.5" />
      <span>تثبيت كتطبيق</span>
    </Button>
  );
}
