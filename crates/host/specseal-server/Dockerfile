# syntax=docker/dockerfile:1
# 多阶段建置：Node 产 SPA 资产 → Rust 内嵌编译 → 最小运行层。build context 是 repo 根：
#   docker build -f crates/host/specseal-server/Dockerfile .
#
# 交付定位：单一 specseal-server binary 同源提供 API 与 SPA（设计 D5／D7）。SPA 资产
# 于 Rust 编译期内嵌进 binary，runtime 不需要 Node、外部 dist volume、CDN 或第二个
# 静态档服务；最终 image 只有 server binary 与 non-root 用户。
#
# 基底定案：alpine（musl），非 distroless（glibc）。理由（rusqlite bundled 实测）：
# - rusqlite bundled 的 SQLite C 原代码在 rust:alpine 加 musl-dev 后编译通过；
#   server binary 依赖树无任何 TLS 原生库（postgres driver 为 NoTls，无
#   openssl/ring/aws-lc），musl 建置没有其他 C 依赖障碍。
# - HEALTHCHECK 需要容器内指令：alpine 内置 busybox wget 可打 /healthz；
#   distroless 无 shell 无工具，得另外编一支探针 binary，复杂度不值。
# - alpine 保留 shell，容器内运行 backup/restore 等子命令与调试都更直接。

# --- Stage 1：Node — 以 lockfile 安装并产出 apps/server-web 的 production dist。 ---
# 钉在建置机原生架构（$BUILDPLATFORM 是 buildx 内置变量）：Vite 产出的 dist 与
# 架构无关，而 Node/V8 的 JIT 在 QEMU 仿真 arm64 下会偶发 SIGILL（exit 132），
# v0.1.1 与 v0.1.2 的首跑都因此红在这一阶段（任务 2.7）。
FROM --platform=$BUILDPLATFORM node:20-alpine AS web
WORKDIR /src
COPY . .
# npm ci 依 package-lock.json 做干净安装（.dockerignore 已排除 host node_modules），
# 再对 server-web 做 Vite production build。dist 于此阶段内生成，不依赖 host build——
# 内嵌来源永远对齐 image 这次的 source revision。
RUN npm ci && npm run build -w apps/server-web

# --- Stage 2：Rust — 编译 specseal-server，内嵌上一阶段产出的 dist。 ---
FROM rust:1-alpine AS build
# musl-dev＋gcc：rusqlite bundled 经 cc crate 编译 SQLite C 原代码所需。
RUN apk add --no-cache musl-dev gcc
WORKDIR /src
COPY . .
# 带入 Node stage 现建的 SPA 资产供 compile-time asset embedding；缺 index 或
# manifest 时 Rust 内嵌会 fail closed（见 crates/host/specseal-server），不产出半成品。
COPY --from=web /src/apps/server-web/dist ./apps/server-web/dist
RUN cargo build --release --locked -p specseal-server

# --- Stage 3：runtime — 只有 server binary 与 non-root 用户，无 Node runtime。 ---
FROM alpine:3.21 AS runtime
# ca-certificates：binary 目前无出站 TLS，但 CA bundle 极小，先备妥（设计决策 1）。
# 固定 uid/gid 10001：bind mount 情境下权限可预期。
RUN apk add --no-cache ca-certificates \
    && addgroup -g 10001 -S specseal \
    && adduser -u 10001 -G specseal -S -h /data specseal
COPY --from=build /src/target/release/specseal-server /usr/local/bin/specseal-server

# 缺省组态：store 与 identity 两个 SQLite 档都落在 /data（volume）。
# 组态 YAML 不做环境变量展开——要改 public_url 等字段，挂载自订档覆盖本路径
# （deploy/docker-compose.yml 以 configs.content 示范经环境变量插值产生组态）。
COPY <<'EOF' /etc/specseal/config.yaml
store:
  driver: sqlite
  path: /data/store.db
identity:
  driver: sqlite
  path: /data/identity.db
EOF

VOLUME /data
EXPOSE 8080
USER specseal
# /healthz 回进程存活（200 空 body）；就绪检查另有 /readyz。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1

# 唯一 ENTRYPOINT 是 server binary；backup/restore/invite 等子命令以
# docker run/exec 覆写参数运行（见 docs/server-deployment.zh-CN.md）。
# --addr 缺省 127.0.0.1（loopback），容器内必须绑 0.0.0.0 对外。
ENTRYPOINT ["/usr/local/bin/specseal-server"]
CMD ["--config", "/etc/specseal/config.yaml", "--addr", "0.0.0.0:8080"]
