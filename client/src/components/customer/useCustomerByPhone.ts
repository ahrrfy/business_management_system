/**
 * خطّاف «العميل بالهاتف» — يربط آلة الحالات النقيّة (`customerByPhoneMachine`) بالخادم
 * (`customers.receptionResolveByPhone`) بلا أيّ عرض. مستهلكاه: شاشة الاستقبال (كان مضمَّناً فيها)
 * وكاشير التجزئة في وضع «توصيل» (م١ PR-B).
 *
 * العقد السلوكيّ (مطابق للاستقبال قبل الاستخراج):
 *  - الرقم المكتمل (١١ خانة) يُبحث تلقائياً بعد ١٨٠ مث؛ رقمٌ موجود يُربط فوراً، ورقمٌ جديد يفتح
 *    حقل الاسم (NEEDS_NAME)، والإنشاء بالاسم يقع بنداءٍ ثانٍ (`resolve(name, true)`).
 *  - تسلسلٌ رقميّ يُسقط ردّاً متأخّراً لرقمٍ قديم (سباق الكتابة السريعة).
 *  - `setCustomer` و`setPhone` متاحان للكتّاب الخارجيّين (استئناف مسوّدة، طلب متجر، محادثة).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { errMsg, notify } from "@/lib/notify";
import { isValidIqMobile } from "@/components/form/PhoneDigitsInput";
import {
  LINK_ANNOUNCE_AR,
  PHONE_LOOKUP_DEBOUNCE_MS,
  creditLimitAfterPhoneChange,
  creditLimitPayload,
  initialCustomerByPhoneState,
  onNameTyped,
  onPhoneChanged,
  onResolveError,
  onResolveResult,
  onResolveStart,
  phaseForPhone,
  sanitizeCreditLimitInput,
  type CustomerByPhoneState,
  type PhoneCustomer,
  type PhoneResolveResult,
} from "./customerByPhoneMachine";

export interface UseCustomerByPhoneOptions {
  /** يُستدعى عند كلّ تغيّرٍ في الهاتف (الاستقبال يُسقط «آجل» مثلاً). */
  onPhoneChange?: () => void;
  /** رقمٌ ابتدائيّ (استئنافُ تبويبٍ محفوظ) — يُبحث تلقائياً كأنّه كُتب للتوّ. */
  initialPhone?: string;
}

export interface CustomerByPhoneApi extends CustomerByPhoneState {
  isValidPhone: boolean;
  isPending: boolean;
  setPhone: (digits: string) => void;
  setCustomer: (customer: PhoneCustomer) => void;
  setCustomerName: (name: string) => void;
  creditLimit: string;
  setCreditLimit: (raw: string) => void;
  /** بحثٌ (بلا اسم) أو إنشاءٌ (بالاسم). `announce` يُظهر توست الربط/الخطأ. */
  resolve: (name?: string, announce?: boolean) => Promise<PhoneResolveResult | null>;
}

export function useCustomerByPhone(opts: UseCustomerByPhoneOptions = {}): CustomerByPhoneApi {
  const [state, setState] = useState<CustomerByPhoneState>(() => initialCustomerByPhoneState(opts.initialPhone ?? ""));
  const [creditLimit, setCreditLimitRaw] = useState("");
  const mutation = trpc.customers.receptionResolveByPhone.useMutation();
  const mutateAsync = mutation.mutateAsync;
  const sequence = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const creditLimitRef = useRef(creditLimit);
  creditLimitRef.current = creditLimit;
  const onPhoneChangeRef = useRef(opts.onPhoneChange);
  onPhoneChangeRef.current = opts.onPhoneChange;

  const resolve = useCallback(async (name?: string, announce = false): Promise<PhoneResolveResult | null> => {
    const phone = stateRef.current.phone;
    if (!isValidIqMobile(phone)) return null;
    const mySequence = ++sequence.current;
    setState((prev) => onResolveStart(prev));
    try {
      const limit = creditLimitPayload(creditLimitRef.current);
      const result = (await mutateAsync({
        phone,
        ...(name?.trim() ? { name: name.trim() } : {}),
        // الخادم يميّز "" (غير مقصود) عن "0" (نقديٌّ فقط) — لا نُرسل الفارغ.
        ...(limit ? { creditLimit: limit } : {}),
      })) as PhoneResolveResult;
      if (mySequence !== sequence.current) return null;
      setState((prev) => onResolveResult(prev, result, name));
      if (announce && result.status === "RESOLVED") {
        notify.ok(result.created ? LINK_ANNOUNCE_AR.created : LINK_ANNOUNCE_AR.linked);
      }
      return result;
    } catch (error: unknown) {
      if (mySequence !== sequence.current) return null;
      const message = errMsg(error) || LINK_ANNOUNCE_AR.failed;
      setState((prev) => onResolveError(prev, message));
      if (announce) notify.err(message);
      return null;
    }
  }, [mutateAsync]);

  // لا نبحث قبل اكتمال الخانات الإحدى عشرة. بعد الاكتمال يتحوّل الهاتف إلى مفتاح هوية واحد:
  // عميلٌ موجود يُربط فوراً، ورقمٌ جديد يفتح الاسم فقط.
  useEffect(() => {
    sequence.current += 1;
    onPhoneChangeRef.current?.();
    if (phaseForPhone(state.phone) !== "READY") return;
    const timer = window.setTimeout(() => { void resolve(); }, PHONE_LOOKUP_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [state.phone, resolve]);

  const setPhone = useCallback((digits: string) => {
    // #3 (تدقيق Codex P1): حدّ الائتمان يتبع هويّة الهاتف — تبدّلُها أو تفريغُها يُصفّره كي لا يرثه
    // العميلُ التالي صامتاً. نلتقط الرقم السابق قبل الانتقال ونصفّره عند اختلافه (لا مع ضغطةٍ تُبقيه).
    const prevPhone = stateRef.current.phone;
    setCreditLimitRaw((limit) => creditLimitAfterPhoneChange(prevPhone, digits, limit));
    setState((prev) => onPhoneChanged(prev, digits));
  }, []);
  const setCustomer = useCallback((customer: PhoneCustomer) => setState((prev) => ({ ...prev, customer })), []);
  const setCustomerName = useCallback((name: string) => setState((prev) => onNameTyped(prev, name)), []);
  const setCreditLimit = useCallback((raw: string) => setCreditLimitRaw(sanitizeCreditLimitInput(raw)), []);

  return {
    ...state,
    isValidPhone: isValidIqMobile(state.phone),
    isPending: mutation.isPending,
    setPhone,
    setCustomer,
    setCustomerName,
    creditLimit,
    setCreditLimit,
    resolve,
  };
}
