#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Smoke test for fork-runtime: each role starts and behaves as documented. Stub only: no Pi seat is
# launched, nothing calls inference, nothing is pushed. Usage: fork/container/smoke.sh [image]
# (default: build HEAD with build.sh).
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
img="${1:-$(bash "${root}/fork/container/build.sh")}"
id="fw$$"
work="$(mktemp -d)"
chmod 0777 "${work}"
cleanup() {
  docker rm -f "${id}-d" "${id}-b" "${id}-w" >/dev/null 2>&1 || true
  # Files the image wrote belong to its uid 10001, so remove them from inside a container.
  docker run --rm -v "${work}:/w" --entrypoint sh "${img}" -c 'rm -rf /w/* 2>/dev/null' >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }
until_ok() { for _ in $(seq "$1"); do if eval "$2" >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }

want="$(node -p "require('${root}/packages/cli/package.json').version")"
# plantworks brands upstream's version (fork/src/cli/program.ts): <upstream>+plantworks.<n>
case "$(docker run --rm "${img}" --version)" in "${want}+plantworks."[0-9]*) ;; *) fail "--version is not ${want}+plantworks.<n>" ;; esac
ok "plantworks --version is ${want}+plantworks.<n>"
[ "$(docker run --rm --entrypoint id "${img}" -u)" = "10001" ] || fail "the image does not run as uid 10001"
ok "runs as non-root uid 10001"
# The daemon's database-conflict stop (fork/src/daemon/boot.ts) finds another holder of its database with lsof.
docker run --rm --entrypoint sh "${img}" -c 'command -v lsof' >/dev/null || fail "lsof is not on PATH: the database-conflict check could not find a holder"
ok "lsof is on PATH (the dependency the database-conflict check needs; the check itself is tested in source)"
docker run --rm --entrypoint sh "${img}" -c 'npm ls -g --depth=0 2>/dev/null' | grep -q "@earendil-works/pi-coding-agent@1.4.0" || fail "Pi 1.4.0 is not the installed Pi"
ok "Pi is the pinned @earendil-works/pi-coding-agent@1.4.0"
docker inspect -f '{{json .Config.Healthcheck.Test}}' "${img}" | grep -q 'entrypoint.sh","health"' || fail "the image declares no role-aware HEALTHCHECK"
ok "the image declares the role-aware HEALTHCHECK"
label() { docker inspect -f "{{index .Config.Labels \"org.opencontainers.image.$1\"}}" "${img}"; }
[ "$(label source)" = "https://github.com/factory-level/plantworks" ] || fail "OCI source label is '$(label source)'"
[ "$(label licenses)" = "Apache-2.0" ] || fail "OCI licenses label is '$(label licenses)'"
case "$(label base.name)" in *@sha256:*) ;; *) fail "OCI base.name label '$(label base.name)' is not the digest-pinned base" ;; esac
[ -n "$(label revision)" ] && [ "$(label revision)" != unknown ] || fail "OCI revision label is unset"
ok "OCI labels: source, licenses=Apache-2.0, base.name=$(label base.name | cut -c1-40)..., revision=$(label revision | cut -c1-12)"
[ "$(docker run --rm --entrypoint rig "${img}" --version)" = "${want}" ] || fail "upstream rig is not on PATH at ${want}"
ok "upstream rig is on PATH (rig --version is ${want})"

set +e
docker run --rm -e OPENRIG_BIND_HOST=0.0.0.0 "${img}" daemon >/dev/null 2>"${work}/refuse.err"
code=$?
set -e
[ "${code}" = 2 ] && grep -q "loopback only" "${work}/refuse.err" || fail "a non-loopback daemon bind was not refused (exit ${code})"
ok "daemon refuses a non-loopback bind (exit 2)"

docker run -d --name "${id}-d" "${img}" daemon >/dev/null
until_ok 90 "docker exec ${id}-d plantworks daemon status | grep -q '^Daemon running'" || { docker logs "${id}-d" | tail -20; fail "the daemon did not start"; }
ok "daemon role starts"
# 7533 = 0x1D6D. It must listen on 127.0.0.1 (0100007F) and not on any other address.
tcp="$(docker exec "${id}-d" cat /proc/net/tcp /proc/net/tcp6 | awk '$4 == "0A" {print $2}')"
echo "${tcp}" | grep -q '^0100007F:1D6D$' || fail "the daemon is not listening on 127.0.0.1:7533"
! echo "${tcp}" | grep ':1D6D$' | grep -qv '^0100007F:' || fail "the daemon listens beyond loopback"
ok "daemon listens on 127.0.0.1:7533 only"
docker exec "${id}-d" rig daemon status | grep -q "^Daemon running on port 7533" || fail "upstream rig does not reach the fork daemon on 7533"
ok "upstream rig reaches the same Pi-only daemon (port 7533)"
docker exec "${id}-d" /app/fork/container/entrypoint.sh health || fail "daemon health check failed"
ok "daemon health check passes"

cat > "${work}/def.json" <<'JSON'
{"team":"smoke","trains":1,"perTrain":{"orchestrators":1,"workers":{"quick":1}},"endpoint":{"url":"${PLANTWORKS_LLM_URL}","slotBudgetKey":"smoke"},"defaultClass":"quick",
 "classes":{"quick":{"slots":1,"model":"qwen3.5:9b","context":{"maxContextTokens":16384,"thinkingTokens":0},"perCall":{"maxOutputTokens":1536,"deadlineSeconds":60},"approval":"never","timeoutSeconds":900,"maxAttempts":1}},
 "events":{"callbackDefault":"${PLANTWORKS_FRONTDOOR_CALLBACK}","approvalConsumer":"frontdoor"}}
JSON
echo '{"slotCaps":{"smoke":1},"models":["qwen3.5:9b"],"maxContextTokens":32768}' > "${work}/platform.json"
docker run --rm -v "${work}:/w" "${img}" pw team emit /w/def.json --out /w/teams --platform /w/platform.json >/dev/null || fail "team emit failed in the image"
ok "pw team emit works in the image"

# The broker shares the daemon's network namespace, as the daemon only binds loopback.
docker run -d --name "${id}-b" --network "container:${id}-d" -v "${work}/teams:/etc/fork/teams:ro" -v "${work}:/w:ro" \
  -e PLANTWORKS_PLATFORM_FILE=/w/platform.json -e PLANTWORKS_FRONTDOOR_CALLBACK=http://127.0.0.1:9/callback "${img}" broker >/dev/null
api() { docker exec "${id}-d" node -e "fetch('http://127.0.0.1:7534/plantworks/v1$1',{method:'$2',headers:{'content-type':'application/json'},body:process.argv[1]||undefined}).then(async r=>console.log(r.status,await r.text()))" "${3:-}"; }
until_ok 30 "api /jobs/kb-smoke-t_1-a1 GET | grep -q '^404'" || { docker logs "${id}-b" | tail -20; fail "the broker did not start"; }
ok "broker role starts on 127.0.0.1:7534 in the daemon's network namespace"
api /jobs POST '{"jobId":"kb-smoke-t_1-a1","team":"smoke","task":{"prompt":"smoke"}}' | grep -q '^201' || fail "submitting a job failed"
api /jobs/kb-smoke-t_1-a1 GET | grep -q '"state":"queued"' || fail "the submitted job is not queued"
ok "broker accepts a job (201, queued)"
docker exec "${id}-b" /app/fork/container/entrypoint.sh health || fail "broker health check (/healthz) failed"
ok "broker health check (/healthz 200) passes"

set +e
docker run --rm "${img}" worker >/dev/null 2>"${work}/worker.err"
code=$?
set -e
[ "${code}" != 0 ] && grep -q "PLANTWORKS_TEAM" "${work}/worker.err" || fail "worker without PLANTWORKS_TEAM did not refuse"
ok "worker role refuses to start without PLANTWORKS_TEAM/PLANTWORKS_SEAT"
# The endpoint is a closed loopback port: the worker's governor starts without calling it.
docker run -d --name "${id}-w" --network "container:${id}-d" -v "${work}/teams:/etc/fork/teams:ro" -v "${work}:/w:ro" \
  -e PLANTWORKS_PLATFORM_FILE=/w/platform.json -e PLANTWORKS_LLM_URL=http://127.0.0.1:9/v1 \
  -e PLANTWORKS_TEAM=smoke -e PLANTWORKS_SEAT=smoke-worker@smoke "${img}" worker >/dev/null
sleep 6
[ "$(docker inspect -f '{{.State.Running}}' "${id}-w")" = true ] || { docker logs "${id}-w" | tail -20; fail "the worker exited"; }
docker exec "${id}-w" /app/fork/container/entrypoint.sh health || fail "worker health check failed"
ok "worker health check passes"
docker exec "${id}-w" cat /var/lib/fork/state/pi/smoke-worker@smoke/agent/models.json | grep -q '"baseUrl": "http://127.0.0.1:7535"' || fail "the worker did not render the seat's models.json at its governor"
ok "worker renders the seat's Pi files at its governor (127.0.0.1:7535)"
# The seat smoke-worker@smoke doesn't exist, so this checks the worker loop runs, not a handoff to Pi.
echo "   job after the worker ran: $(api /jobs/kb-smoke-t_1-a1 GET | cut -c1-160)"
echo "   worker log: $(docker logs "${id}-w" 2>&1 | tail -n 3 | tr '\n' ' ' | cut -c1-240)"
echo "   broker log: $(docker logs "${id}-b" 2>&1 | grep -i 'handoff\|claim\|refused' | tail -n 2 | tr '\n' ' ' | cut -c1-300)"
docker stop -t 10 "${id}-w" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "${id}-w")" = 0 ] || fail "the worker did not stop cleanly on SIGTERM"
ok "worker role runs against the broker and stops cleanly on SIGTERM"
echo "smoke: all checks passed for ${img}"
