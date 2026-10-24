# SPDX-License-Identifier: Apache-2.0
# The fork's runtime image: one image, three roles (daemon, broker, worker), chosen by the first
# argument to the entrypoint. Built only by fork/container/build.sh, from a clean `git archive` of
# one commit: untracked and local files can't reach the image, but every file tracked at that
# commit does, so a secret committed to the repository would too.
# Nothing is pushed: the image is tagged locally (fork-runtime:<commit>).
#
# Pins:
# - the base is upstream's digest-pinned Debian (docker/testbed/base-image); build.sh refuses a
#   floating tag;
# - Node is the same version upstream's testbed pins, checked against nodejs.org's SHASUMS256;
# - Pi is @earendil-works/pi-coding-agent@1.4.0, the platform pin, with its npm integrity checked
#   before install.

ARG BASE_IMAGE

# --- build: the monorepo's upstream packages (the fork imports their dist/) and the fork itself ---
FROM ${BASE_IMAGE} AS build
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3 make g++; \
    rm -rf /var/lib/apt/lists/*
ARG NODE_VERSION=22.22.1
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in amd64) a=x64 ;; arm64) a=arm64 ;; *) echo "unsupported TARGETARCH=${TARGETARCH:-unset}; build with BuildKit (build.sh does)" >&2; exit 1 ;; esac; \
    f="node-v${NODE_VERSION}-linux-${a}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${f}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${f}\$" | sha256sum -c -; \
    tar -xJf "${f}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "${f}"; node --version
WORKDIR /app
COPY . .
# Only the packages the fork imports at runtime (the CLI and the daemon) are built.
RUN npm ci --no-audit --no-fund && npm run build -w packages/daemon -w packages/cli
# Pi, pinned by version and npm integrity. npm still resolves Pi's own dependencies from the registry.
ARG PI_PACKAGE=@earendil-works/pi-coding-agent@1.4.0
ARG PI_INTEGRITY=sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==
RUN set -eux; \
    mkdir /pi && cd /pi; \
    got="$(npm pack "${PI_PACKAGE}" --json --ignore-scripts | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s)[0];console.log(p.integrity+" "+p.filename)})')"; \
    test "${got%% *}" = "${PI_INTEGRITY}" || { echo "Pi integrity mismatch: ${got}" >&2; exit 1; }; \
    npm install -g --no-audit --no-fund "/pi/${got#* }"

# --- runtime ---
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ARG SOURCE_COMMIT=unknown
# OCI metadata. base.name is the digest-pinned base reference build.sh passed in.
LABEL org.opencontainers.image.source="https://github.com/factory-level/plantworks" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="${BASE_IMAGE}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates tini tmux git procps; \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local /usr/local
COPY --from=build /app /app
RUN set -eux; \
    ln -s /app/fork/bin/plantworks.mjs /usr/local/bin/plantworks; \
    ln -s /app/fork/bin/plantworks.mjs /usr/local/bin/pwctl; \
    chmod +x /app/packages/cli/dist/bin-wrapper.js; \
    ln -s /app/packages/cli/dist/bin-wrapper.js /usr/local/bin/rig; \
    useradd --uid 10001 --create-home --shell /bin/bash fork; \
    mkdir -p /var/lib/fork /etc/fork/teams; \
    chown fork:fork /var/lib/fork
# All state lives under one explicit path: mount a volume here. Team specs are read from
# /etc/fork/teams (mount emitted <team>/team.json files read-only).
# Upstream `rig` (the CLI Pi seats use, for example to close their qitems) reaches the same
# Pi-only daemon as `plantworks`: the same home, the PW-16 port and no kernel.
ENV OPENRIG_HOME=/var/lib/fork \
    OPENRIG_PORT=7533 \
    OPENRIG_NO_KERNEL=1 \
    PLANTWORKS_TEAMS_DIR=/etc/fork/teams \
    NODE_ENV=production
USER fork
WORKDIR /var/lib/fork
# Health by role (see entrypoint.sh `health`): the broker's /healthz, the daemon's status, the worker's process.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["/app/fork/container/entrypoint.sh", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/fork/container/entrypoint.sh"]
CMD ["help"]
