#!/usr/bin/env bash
set -euo pipefail

readonly UNIT="erp-pm2-contract-test.service"
readonly SEED_UNIT="erp-pm2-contract-seed.service"
readonly HELPER_TARGET="/usr/local/libexec/erp/pm2-systemd-start.mjs"
readonly UNIT_TARGET="/etc/systemd/system/${UNIT}"
readonly DROPIN_DIR="/etc/systemd/system/${UNIT}.d"
readonly PID_FILE="/run/erp-pm2/pm2-deploy.pid"
readonly PM2_BIN="/usr/lib/node_modules/pm2/bin/pm2"

if [[ "${EUID}" -ne 0 ]]; then
  echo "pm2 systemd linux test: root required" >&2
  exit 1
fi
if [[ "$(cat /proc/1/comm)" != "systemd" || ! -d /run/systemd/system ]]; then
  echo "pm2 systemd linux test: systemd must be PID 1" >&2
  exit 1
fi
if id deploy >/dev/null 2>&1; then
  echo "pm2 systemd linux test: refusing to reuse an existing deploy account" >&2
  exit 1
fi
if [[ ! -f "${PM2_BIN}" ]]; then
  echo "pm2 systemd linux test: PM2 7.0.3 must be installed under /usr" >&2
  exit 1
fi

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
created_user=0
created_docker_group=0

cleanup() {
  systemctl stop "${UNIT}" >/dev/null 2>&1 || true
  systemctl stop "${SEED_UNIT}" >/dev/null 2>&1 || true
  if [[ "${created_user}" -eq 1 ]]; then
    /usr/bin/setpriv --reuid="$(id -u deploy)" --regid="$(id -g deploy)" --init-groups -- \
      /usr/bin/env HOME=/home/deploy USER=deploy LOGNAME=deploy PM2_HOME=/home/deploy/.pm2 \
      /usr/bin/node "${PM2_BIN}" kill >/dev/null 2>&1 || true
  fi
  rm -f "${UNIT_TARGET}"
  rm -rf "${DROPIN_DIR}"
  rm -f "${HELPER_TARGET}"
  rmdir /usr/local/libexec/erp >/dev/null 2>&1 || true
  rm -rf /run/erp-pm2
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ "${created_user}" -eq 1 ]]; then
    userdel -r deploy >/dev/null 2>&1 || true
  fi
  if [[ "${created_docker_group}" -eq 1 ]]; then
    groupdel docker >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

useradd --create-home --shell /bin/bash deploy
created_user=1
if ! getent group docker >/dev/null; then
  groupadd docker
  created_docker_group=1
fi
usermod --append --groups docker deploy

# Run through the actual PM2 daemon: a CLI with correct login groups must not
# hide a daemon that lost the Docker group at clean boot.
cat > /home/deploy/backup-permission-probe.cjs <<'NODE'
const fs = require('node:fs');
const data = fs.readFileSync('/run/erp-pm2/backup-permission-probe', 'utf8');
fs.writeFileSync('/home/deploy/backup-permission-result', data);
NODE
chmod 0644 /home/deploy/backup-permission-probe.cjs

install -d -o root -g root -m 0755 /usr/local/libexec/erp
install -o root -g root -m 0755 \
  "${PROJECT_ROOT}/deploy/systemd/pm2-systemd-start.mjs" "${HELPER_TARGET}"
install -o root -g root -m 0644 \
  "${PROJECT_ROOT}/deploy/systemd/pm2-systemd-contract-test.service" "${UNIT_TARGET}"
install -d -o root -g root -m 0755 "${DROPIN_DIR}"
install -o root -g root -m 0644 \
  "${PROJECT_ROOT}/deploy/systemd/pm2-deploy.service.d/20-pidfile-reconcile.conf" \
  "${DROPIN_DIR}/20-pidfile-reconcile.conf"
systemctl daemon-reload
systemd-analyze verify "${UNIT_TARGET}"

assert_active_contract() {
  local expected_pid="$1"
  local require_sanitized_identity="$2"
  local main_pid
  main_pid="$(systemctl show "${UNIT}" --property=MainPID --value)"
  [[ "$(systemctl is-active "${UNIT}")" == "active" ]]
  [[ "${main_pid}" == "${expected_pid}" ]]
  [[ "$(cat "${PID_FILE}")" == "${expected_pid}" ]]
  [[ "$(stat -c '%U:%G:%a' "${PID_FILE}")" == "root:root:644" ]]
  [[ "$(stat -c '%U:%G:%a' "${HELPER_TARGET}")" == "root:root:755" ]]
  [[ "$(awk '/^Uid:/{print $2}' "/proc/${main_pid}/status")" == "$(id -u deploy)" ]]
  if [[ "${require_sanitized_identity}" == "yes" ]]; then
    local expected_groups actual_groups
    expected_groups="$(id -G deploy | tr ' ' '\n' | sort -nu | tr '\n' ' ')"
    actual_groups="$(awk '/^Groups:/{for (i=2;i<=NF;i++) print $i}' "/proc/${main_pid}/status" | sort -nu | tr '\n' ' ')"
    [[ "${actual_groups}" == "${expected_groups}" ]]
    [[ "$(awk '/^CapEff:/{print $2}' "/proc/${main_pid}/status")" == "0000000000000000" ]]
    [[ "$(awk '/^CapBnd:/{print $2}' "/proc/${main_pid}/status")" == "0000000000000000" ]]
    [[ "$(awk '/^CapAmb:/{print $2}' "/proc/${main_pid}/status")" == "0000000000000000" ]]
    if tr '\0' '\n' < "/proc/${main_pid}/environ" | grep -q '^PM2_SYSTEMD_ATTACK='; then
      echo "pm2 systemd linux test: inherited environment reached deploy daemon" >&2
      exit 1
    fi
  fi
  printf 'backup group access verified\n' > /run/erp-pm2/backup-permission-probe
  chown root:docker /run/erp-pm2/backup-permission-probe
  chmod 0640 /run/erp-pm2/backup-permission-probe
  rm -f /home/deploy/backup-permission-result
  /usr/bin/setpriv --reuid="$(id -u deploy)" --regid="$(id -g deploy)" --init-groups -- \
    /usr/bin/env HOME=/home/deploy USER=deploy LOGNAME=deploy PM2_HOME=/home/deploy/.pm2 \
    /usr/bin/node "${PM2_BIN}" start /home/deploy/backup-permission-probe.cjs \
    --name erp-backup-permission-probe --cwd /home/deploy \
    --interpreter /usr/bin/node --no-autorestart >/dev/null
  for attempt in {1..40}; do
    cmp -s /run/erp-pm2/backup-permission-probe /home/deploy/backup-permission-result && break
    sleep 0.25
  done
  if ! cmp -s /run/erp-pm2/backup-permission-probe /home/deploy/backup-permission-result; then
    cat /home/deploy/.pm2/logs/erp-backup-permission-probe-error.log >&2 || true
    return 1
  fi
  cmp /run/erp-pm2/backup-permission-probe /home/deploy/backup-permission-result
  if journalctl -u "${UNIT}" --since=-1min --no-pager | grep -q 'does not belong to service'; then
    echo "pm2 systemd linux test: systemd rejected the reconciled main PID" >&2
    exit 1
  fi
}

proc_start_time() {
  sed -E 's/^[0-9]+ \(.*\) //' "/proc/$1/stat" | awk '{print $20}'
}

# Existing daemon: seed it under a separate systemd cgroup so its orphan parent
# is PID 1 even in WSL. The target service must adopt it across that cgroup.
systemd-run --unit="${SEED_UNIT}" --property=User=deploy --property=Type=oneshot \
  --property=RemainAfterExit=yes --property=KillMode=none \
  --setenv=HOME=/home/deploy --setenv=USER=deploy --setenv=LOGNAME=deploy \
  --setenv=PM2_HOME=/home/deploy/.pm2 \
  /usr/bin/node "${PM2_BIN}" ping >/dev/null
systemctl is-active --quiet "${SEED_UNIT}"
existing_pid="$(cat /home/deploy/.pm2/pm2.pid)"
existing_start="$(proc_start_time "${existing_pid}")"
grep -Fq "/system.slice/${SEED_UNIT}" "/proc/${existing_pid}/cgroup"
[[ "$(/usr/bin/node "${HELPER_TARGET}" --inspect)" == "${existing_pid} ${existing_start}" ]]
systemctl start "${UNIT}"
assert_active_contract "${existing_pid}" no
[[ "$(proc_start_time "${existing_pid}")" == "${existing_start}" ]]
echo "pm2 systemd adoption: pid=${existing_pid} start=${existing_start} owner=root:root:644 cgroup=external"
systemctl stop "${UNIT}"

# Clean boot: no daemon or PM2 home exists. The same helper must start PM2 as
# deploy and hand systemd a trusted root-owned PID file.
rm -rf /home/deploy/.pm2 /run/erp-pm2
systemctl start "${UNIT}"
clean_pid="$(systemctl show "${UNIT}" --property=MainPID --value)"
assert_active_contract "${clean_pid}" yes
service_cgroup="$(systemctl show "${UNIT}" --property=ControlGroup --value)"
grep -Fq "${service_cgroup}" "/proc/${clean_pid}/cgroup"
echo "pm2 systemd clean boot: pid=${clean_pid} owner=root:root:644 cgroup=${service_cgroup}"
systemctl stop "${UNIT}"

echo "pm2 systemd linux integration: existing daemon + clean boot passed"
