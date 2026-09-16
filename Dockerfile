# ---------------------------------------------------------------------------
# Stage 1 — Build (alpine has the toolchain we need)
# ---------------------------------------------------------------------------
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Dependency manifests first (Docker layer cache)
COPY package.json bun.lock tsconfig.json ./
COPY src/ src/

RUN bun install --frozen-lockfile \
 && bun run build \
 # Prune devDependencies for the runtime image (build is done by now)
 && bun install --frozen-lockfile --production

# Static musl bun binary: zero glibc runtime dependency, runs in distroless.
# NOTE: bun-linux-x64-musl.zip (not the glibc bun-linux-x64.zip). The musl
# build needs its loader + libstdc++/libgcc — staged with cp -L so symlinks
# become real files for the distroless COPY.
RUN apk add --no-cache wget unzip \
 && wget -O /tmp/bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64-musl.zip \
 && unzip -o /tmp/bun.zip -d /tmp/bunx \
 && mkdir -p /out/bin /out/lib \
 && mv /tmp/bunx/bun-linux-x64-musl/bun /out/bin/bun \
 && chmod +x /out/bin/bun \
 && cp -L /lib/ld-musl-x86_64.so.1 /out/lib/ \
 && cp -L /usr/lib/libstdc++.so.6 /out/lib/ \
 && cp -L /usr/lib/libgcc_s.so.1 /out/lib/ \
 && rm -rf /tmp/bun.zip /tmp/bunx \
 && apk del wget unzip

COPY . .

# ---------------------------------------------------------------------------
# Stage 2 — Runtime (distroless: no shell, no package manager, non-root)
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/base-debian12

WORKDIR /app

COPY --from=builder /out/bin/bun /usr/local/bin/bun
COPY --from=builder /out/lib/ld-musl-x86_64.so.1 /lib/ld-musl-x86_64.so.1
COPY --from=builder /out/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=builder /out/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/spec ./spec
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

USER 65532:65532

ENV NODE_ENV=production

EXPOSE 3000

# HTTP host mode activates when GOMODEL_HTTP_TOKEN is set at runtime
# (streamable-HTTP MCP on 0.0.0.0:$PORT/mcp, default port 3000).
CMD ["/usr/local/bin/bun", "dist/index.js"]
