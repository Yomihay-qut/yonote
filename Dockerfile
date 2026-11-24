# syntax=docker/dockerfile:1

FROM node:22-alpine AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.25-alpine AS server-builder
ARG APP_VERSION=0.9.1
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN rm -rf ./webdist
COPY --from=web-builder /src/web/dist ./webdist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.appVersion=${APP_VERSION}" -o /out/yonote .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata \
 && addgroup -g 1000 -S yonote \
 && adduser -u 1000 -S -G yonote -H -D yonote \
 && mkdir -p /app /data \
 && chown -R yonote:yonote /app /data

WORKDIR /app
COPY --from=server-builder /out/yonote /app/yonote

USER yonote
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/app/yonote", "-addr", "0.0.0.0:8787", "-data", "/data"]
