#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Builds fork-runtime:<commit> locally from a clean `git archive` of one commit (default HEAD).
# It never pushes. Usage: fork/container/build.sh [commit]
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
commit="$(git -C "${root}" rev-parse "${1:-HEAD}")"
# Upstream's digest-pinned base. A reference without @sha256: is refused.
base="$(grep -v '^#' "${root}/docker/testbed/base-image" | grep -v '^[[:space:]]*$' | head -n1)"
case "${base}" in *@sha256:*) ;; *) echo "build.sh: ${base} is not digest-pinned" >&2; exit 1 ;; esac

ctx="$(mktemp -d)"
trap 'rm -rf "${ctx}"' EXIT
git -C "${root}" archive "${commit}" | tar -x -C "${ctx}"

tag="fork-runtime:${commit:0:12}"
DOCKER_BUILDKIT=1 docker build --file "${ctx}/fork/container/Dockerfile" --build-arg "BASE_IMAGE=${base}" --build-arg "SOURCE_COMMIT=${commit}" --tag "${tag}" "${ctx}" >&2
echo "${tag}"
