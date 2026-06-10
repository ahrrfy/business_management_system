#!/usr/bin/env bash
# ينتظر صحّة حاوية MySQL قبل إقلاع التطبيق (يُستدعى من ExecStartPre لوحدة PM2).
# يزيل سباق الإقلاع: systemd يبدأ PM2 قبل جاهزية القاعدة ⇒ انهيارات متكرّرة عند الإقلاع.
# الاستخدام: wait-mysql-healthy.sh [اسم_الحاوية] [مهلة_بالثواني]
set -u
CONTAINER="${1:-${DB_CONTAINER:-erp-mysql}}"
TIMEOUT="${2:-180}"
WAITED=0
echo "wait-mysql-healthy: انتظار صحّة ${CONTAINER} (حتى ${TIMEOUT}ث)…"
while [ "$WAITED" -lt "$TIMEOUT" ]; do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
  if [ "$STATUS" = "healthy" ]; then
    echo "wait-mysql-healthy: ${CONTAINER} سليمة بعد ${WAITED}ث."
    exit 0
  fi
  sleep 5
  WAITED=$((WAITED + 5))
done
echo "wait-mysql-healthy: مهلة ${TIMEOUT}ث انقضت وحالة ${CONTAINER}=${STATUS} — فشل." >&2
exit 1
