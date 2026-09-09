import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { trpc } from "@/lib/trpc";
import { translateLoginError } from "@/lib/loginErrors";
import { cn } from "@/lib/utils";
import {
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  Fingerprint,
  Loader2,
} from "lucide-react";

export interface TwoFactorFormProps {
  ticket: string | null;
  onSuccess: (data: { mustChangePassword: boolean; recoveryCodesRemaining?: number | null }) => Promise<void> | void;
  onError: (errorMessage: string) => void;
  onBack: () => void;
  onExpired: () => void;
}

export function TwoFactorForm({
  ticket,
  onSuccess,
  onError,
  onBack,
  onExpired,
}: TwoFactorFormProps) {
  const [otp, setOtp] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [twoFactorStatus, setTwoFactorStatus] = useState<"idle" | "verifying" | "success" | "error">("idle");
  const [shakeKey, setShakeKey] = useState(0);
  const shouldReduceMotion = Boolean(useReducedMotion());

  const verify2fa = trpc.auth.twoFactorVerify.useMutation({
    onMutate: () => {
      setTwoFactorStatus("verifying");
    },
    onSuccess: async (data) => {
      setTwoFactorStatus("success");
      if (data.recoveryCodesRemaining != null && data.recoveryCodesRemaining <= 3) {
        console.warn(`رموز الاسترداد المتبقية: ${data.recoveryCodesRemaining}`);
      }
      await new Promise((r) => setTimeout(r, 650));
      await onSuccess(data);
    },
    onError: (e) => {
      setTwoFactorStatus("error");
      setShakeKey((k) => k + 1);
      const translated = translateLoginError(e.message);
      onError(translated);
      setOtp("");
      if (e.message.includes("انتهت مهلة التحقق")) {
        setTimeout(() => {
          onExpired();
        }, 1200);
      } else {
        setTimeout(() => {
          setTwoFactorStatus("idle");
        }, 1500);
      }
    },
  });

  function submitOtp(code?: string) {
    if (!ticket || verify2fa.isPending) return;
    if (useRecovery) {
      const trimmed = recoveryCode.trim();
      if (!trimmed) return;
      verify2fa.mutate({ ticket, recoveryCode: trimmed });
    } else {
      const c = (code ?? otp).trim();
      if (c.length !== 6) return;
      verify2fa.mutate({ ticket, code: c });
    }
  }

  return (
    <motion.form
      key="otp-form"
      initial={shouldReduceMotion ? false : { opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={shouldReduceMotion ? undefined : { opacity: 0, x: 16 }}
      transition={{ duration: 0.2 }}
      onSubmit={(e) => {
        e.preventDefault();
        submitOtp();
      }}
      className="space-y-6 relative z-20"
    >
      <div className="flex flex-col items-center justify-center pt-1 pb-1">
        <div className="relative flex items-center justify-center size-20">
          <motion.div
            animate={
              shouldReduceMotion
                ? undefined
                : twoFactorStatus === "verifying"
                ? { scale: [1, 1.4, 1], opacity: [0.3, 0.7, 0.3] }
                : twoFactorStatus === "error"
                ? { scale: [1, 1.25, 1], opacity: [0.4, 0.8, 0.4] }
                : { scale: [1, 1.15, 1], opacity: [0.15, 0.35, 0.15] }
            }
            transition={
              shouldReduceMotion
                ? undefined
                : { repeat: Infinity, duration: twoFactorStatus === "verifying" ? 1.2 : 3, ease: "easeInOut" }
            }
            className={cn(
              "absolute inset-0 rounded-full border",
              twoFactorStatus === "success"
                ? "border-[#34d399]/40 bg-[rgba(16,185,129,0.1)] shadow-[0_0_25px_rgba(16,185,129,0.3)]"
                : twoFactorStatus === "error"
                ? "border-destructive/50 bg-destructive/10 shadow-[0_0_25px_rgba(239,68,68,0.35)]"
                : twoFactorStatus === "verifying"
                ? "border-cyan-400/50 bg-cyan-500/10 shadow-[0_0_25px_rgba(6,182,212,0.35)]"
                : "border-blue-500/30 bg-blue-500/5 shadow-[0_0_20px_rgba(59,130,246,0.15)]"
            )}
          />

          <motion.div
            animate={shouldReduceMotion ? undefined : { rotate: 360 }}
            transition={shouldReduceMotion ? undefined : { repeat: Infinity, duration: 8, ease: "linear" }}
            className={cn(
              "absolute -inset-1 rounded-full border border-dashed pointer-events-none",
              twoFactorStatus === "success"
                ? "border-[#34d399]/60"
                : twoFactorStatus === "error"
                ? "border-destructive/60"
                : twoFactorStatus === "verifying"
                ? "border-cyan-400/80"
                : "border-white/20"
            )}
          />

          <div
            className={cn(
              "relative size-14 rounded-2xl flex items-center justify-center backdrop-blur-xl border transition-all duration-300 shadow-inner",
              twoFactorStatus === "success"
                ? "bg-[rgba(16,185,129,0.2)] border-[#34d399]/60 text-money-positive"
                : twoFactorStatus === "error"
                ? "bg-destructive/20 border-destructive/60 text-destructive"
                : twoFactorStatus === "verifying"
                ? "bg-cyan-500/20 border-cyan-400/60 text-cyan-300"
                : "bg-white/[0.06] border-white/20 text-slate-200"
            )}
          >
            <AnimatePresence mode="wait">
              {twoFactorStatus === "success" ? (
                <motion.div
                  key="success-icon"
                  initial={{ scale: 0, rotate: -45 }}
                  animate={{ scale: 1, rotate: 0 }}
                  exit={{ scale: 0 }}
                  transition={{ type: "spring", stiffness: 350, damping: 20 }}
                >
                  <CheckCircle2 className="size-7" />
                </motion.div>
              ) : twoFactorStatus === "error" ? (
                <motion.div
                  key="error-icon"
                  initial={{ scale: 0, rotate: 45 }}
                  animate={{ scale: 1, rotate: 0 }}
                  exit={{ scale: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                >
                  <ShieldAlert className="size-7" />
                </motion.div>
              ) : twoFactorStatus === "verifying" ? (
                <motion.div
                  key="verifying-icon"
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                >
                  <Loader2 className="size-7" />
                </motion.div>
              ) : (
                <motion.div
                  key="idle-icon"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <Fingerprint className="size-7" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {useRecovery ? (
        <div className="space-y-2">
          <Label htmlFor="recoveryCode" className="text-xs font-medium text-slate-300 tracking-wide block text-center">
            رمز الاسترداد البديل للطوارئ
          </Label>
          <Input
            id="recoveryCode"
            type="text"
            dir="ltr"
            autoComplete="one-time-code"
            placeholder="XXXXX-XXXXX"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            className="h-12 font-mono text-center tracking-widest bg-white/[0.04] hover:bg-white/[0.06] border border-white/[0.1] rounded-2xl text-white focus:border-white/30"
            autoFocus
            required
          />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <motion.div
            key={shakeKey}
            animate={shakeKey > 0 && !shouldReduceMotion ? { x: [0, -14, 14, -10, 10, -5, 5, 0] } : {}}
            transition={{ duration: 0.45, ease: "easeInOut" }}
            dir="ltr"
            className="relative p-1"
          >
            {twoFactorStatus === "verifying" && !shouldReduceMotion && (
              <motion.div
                className="absolute inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400 to-transparent z-30 pointer-events-none"
                animate={{ top: ["0%", "100%", "0%"] }}
                transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
              />
            )}

            <InputOTP
              maxLength={6}
              pattern={REGEXP_ONLY_DIGITS}
              inputMode="numeric"
              autoFocus
              value={otp}
              onChange={setOtp}
              onComplete={(v) => submitOtp(v)}
              disabled={verify2fa.isPending}
            >
              <InputOTPGroup className="gap-2 sm:gap-2.5">
                {[0, 1, 2, 3, 4, 5].map((i) => {
                  const isFilled = otp.length > i;
                  const isCurrent = otp.length === i;
                  return (
                    <InputOTPSlot
                      key={i}
                      index={i}
                      className={cn(
                        "h-13 w-11 sm:w-12 rounded-2xl font-mono text-xl font-bold transition-all duration-200 text-white shadow-[0_2px_10px_rgba(0,0,0,0.3)_inset]",
                        twoFactorStatus === "error"
                          ? "border-destructive/60 bg-destructive/10 text-destructive ring-1 ring-destructive/40 shadow-[0_0_15px_rgba(239,68,68,0.25)]"
                          : twoFactorStatus === "success"
                          ? "border-[#34d399]/80 bg-[rgba(16,185,129,0.15)] text-money-positive ring-1 ring-[#34d399]/50 shadow-[0_0_15px_rgba(16,185,129,0.25)]"
                          : twoFactorStatus === "verifying"
                          ? "border-cyan-400/50 bg-cyan-500/5 ring-1 ring-cyan-400/30"
                          : isCurrent
                          ? "border-white/50 bg-white/[0.08] ring-2 ring-white/20 scale-105"
                          : isFilled
                          ? "border-white/25 bg-white/[0.05]"
                          : "border-white/[0.1] bg-white/[0.03] text-slate-500"
                      )}
                    />
                  );
                })}
              </InputOTPGroup>
            </InputOTP>
          </motion.div>

          <div className="flex items-center gap-2 pt-1" dir="ltr">
            {[0, 1, 2, 3, 4, 5].map((idx) => {
              const active = otp.length > idx;
              return (
                <span
                  key={idx}
                  className={cn(
                    "h-1 rounded-full transition-all duration-300",
                    active
                      ? twoFactorStatus === "error"
                        ? "w-4 bg-destructive shadow-[0_0_8px_rgba(239,68,68,0.8)]"
                        : twoFactorStatus === "success"
                        ? "w-4 bg-money-positive shadow-[0_0_8px_rgba(16,185,129,0.8)]"
                        : "w-4 bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]"
                      : "w-1.5 bg-white/15"
                  )}
                />
              );
            })}
          </div>
        </div>
      )}

      <Button
        type="submit"
        className={cn(
          "w-full h-12 rounded-2xl font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2 relative overflow-hidden active:scale-[0.98]",
          twoFactorStatus === "success"
            ? "bg-[rgba(16,185,129,0.85)] hover:bg-[rgba(16,185,129,0.9)] text-white shadow-[0_4px_20px_rgba(16,185,129,0.4)] border border-[#34d399]/40"
            : twoFactorStatus === "error"
            ? "bg-destructive/90 hover:bg-destructive text-white shadow-[0_4px_20px_rgba(239,68,68,0.4)] border border-destructive/40"
            : twoFactorStatus === "verifying"
            ? "bg-cyan-600/90 text-white shadow-[0_4px_20px_rgba(6,182,212,0.35)] border border-cyan-400/40"
            : "bg-gradient-to-b from-[#2563eb] to-[#1d4ed8] hover:from-[#3b82f6] hover:to-[#2563eb] text-white shadow-[0_4px_18px_rgba(37,99,235,0.35),0_1px_0_rgba(255,255,255,0.25)_inset] border border-blue-400/30"
        )}
        disabled={verify2fa.isPending || twoFactorStatus === "success"}
      >
        {twoFactorStatus === "verifying" ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            <span>جارٍ فك التشفير وتأكيد البصمة…</span>
          </>
        ) : twoFactorStatus === "success" ? (
          <>
            <CheckCircle2 className="size-4" />
            <span>تم التحقق واعتماد الجلسة</span>
          </>
        ) : (
          <>
            <ShieldCheck className="size-4" aria-hidden />
            <span>تأكيد ومتابعة</span>
          </>
        )}
      </Button>

      <div className="flex items-center justify-between text-xs pt-1">
        <button
          type="button"
          className="text-slate-400 hover:text-white transition"
          onClick={() => {
            setUseRecovery((v) => !v);
          }}
        >
          {useRecovery ? "استخدام رمز التطبيق" : "رمز استرداد بديل"}
        </button>
        <button
          type="button"
          className="text-slate-400 hover:text-white transition"
          onClick={onBack}
        >
          رجوع
        </button>
      </div>
    </motion.form>
  );
}

export default TwoFactorForm;
