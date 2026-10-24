#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The image's entrypoint: `daemon`, `broker` or `worker` runs that role. Anything else is passed to
# the `plantworks` CLI, for example `--version` or `pw team emit ...`.
#
# Network: the daemon binds 127.0.0.1 only, because its queue routes aren't authenticated (PW-16).
# So the broker and workers must share the daemon's network namespace (one pod, or Docker's
# `--network container:<daemon>`). These images don't provide remote seat transport: Pi seats run
# in the daemon's container, as local tmux sessions. Run exactly one worker per seat, with a
# unique, stable PLANTWORKS_SEAT: never several replicas sharing one seat.
set -euo pipefail

role="${1:-help}"
# The image's HEALTHCHECK runs `entrypoint.sh health` and can't see which role started the
# container, so each long-running role records itself here.
role_file="${FORK_ROLE_FILE:-/tmp/fork-role}"
loopback_of() { case "$1" in 0.0.0.0|::|"") echo 127.0.0.1 ;; *) echo "$1" ;; esac; }
case "${role}" in
  daemon)
    shift
    host="${OPENRIG_BIND_HOST:-127.0.0.1}"
    case "${host}" in
      127.0.0.1|localhost|::1) ;;
      *) echo "fork-runtime: refusing to bind the daemon on ${host}; it binds loopback only (its queue routes are unauthenticated)" >&2; exit 2 ;;
    esac
    echo daemon > "${role_file}"
    plantworks daemon start --host "${host}" "$@"
    # `daemon start` detaches the daemon. Follow its log into the container's output, and stop
    # the container when the daemon stops.
    plantworks daemon logs --follow &
    trap 'plantworks daemon stop || true; exit 0' TERM INT
    while plantworks daemon status 2>/dev/null | grep -q "^Daemon running"; do sleep 5 & wait $!; done
    echo "fork-runtime: the daemon is no longer running" >&2
    exit 1
    ;;
  broker)
    shift
    args=(pw broker serve --host "${PLANTWORKS_BROKER_HOST:-127.0.0.1}" --port "${PLANTWORKS_BROKER_PORT:-7534}")
    [ -n "${PLANTWORKS_PLATFORM_FILE:-}" ] && args+=(--platform "${PLANTWORKS_PLATFORM_FILE}")
    [ -n "${PLANTWORKS_BROKER_DB:-}" ] && args+=(--db "${PLANTWORKS_BROKER_DB}")
    echo broker > "${role_file}"
    exec plantworks "${args[@]}" "$@"
    ;;
  worker)
    shift
    : "${PLANTWORKS_TEAM:?set PLANTWORKS_TEAM to the team this worker serves}"
    : "${PLANTWORKS_SEAT:?set PLANTWORKS_SEAT to the Pi seat session this worker drives}"
    args=(pw worker run --team "${PLANTWORKS_TEAM}" --seat "${PLANTWORKS_SEAT}")
    [ -n "${PLANTWORKS_CLASS:-}" ] && args+=(--class "${PLANTWORKS_CLASS}")
    # exec keeps this PID, so health checks exactly this worker process.
    echo "worker $$" > "${role_file}"
    exec plantworks "${args[@]}" "$@"
    ;;
  health)
    # Container health, by role. The broker: its unauthenticated /healthz (PW-22) answers 200, which
    # means the process serves and its store answers. The daemon: `daemon status` reports it running
    # and not UNHEALTHY. The worker: the `pw worker run` process the role started is alive and `pw worker live`
    # finds no recorded Pi exit for its seat. Health says nothing about
    # jobs or about any Pi run.
    read -r recorded pid < "${role_file}" 2>/dev/null || true
    case "${recorded:-}" in
      broker)
        url="http://$(loopback_of "${PLANTWORKS_BROKER_HOST:-127.0.0.1}"):${PLANTWORKS_BROKER_PORT:-7534}/healthz"
        exec node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))' "${url}"
        ;;
      daemon)
        status="$(plantworks daemon status 2>/dev/null || true)"
        echo "${status}" | grep -q "^Daemon running" && ! echo "${status}" | grep -q "UNHEALTHY"
        ;;
      # The worker process is alive, and its seat's Pi hasn't recorded an exit (runner-state.json).
      worker) [ -n "${pid:-}" ] && kill -0 "${pid}" 2>/dev/null && plantworks pw worker live --seat "${PLANTWORKS_SEAT:?}" >/dev/null ;;
      *) exit 0 ;;  # a one-off command, not a long-running role
    esac
    ;;
  help)
    sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    exec plantworks "$@"
    ;;
esac
