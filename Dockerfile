FROM golang:1.27-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY VERSION main.go ./
COPY internal ./internal

# Only the dev-container workflow sets these; release images report the plain VERSION.
ARG BUILD_CHANNEL=""
ARG BUILD_COMMIT=""

# CGO is off: SQLite is the pure-Go port, so the binary is fully static.
RUN V="$(cat VERSION)${BUILD_CHANNEL:+-$BUILD_CHANNEL}${BUILD_COMMIT:++$BUILD_COMMIT}" && \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$V" -o /tubeshelf . && \
    mkdir -p /out/data

FROM scratch

# Root certificates for the HTTPS calls to YouTube and OIDC providers.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /tubeshelf /tubeshelf
# Same path as v1, so existing volume mounts keep working.
COPY --from=build --chown=1000:1000 /out/data /app/data

ENV TUBESHELF_DATA=/app/data
USER 1000:1000
EXPOSE 3000
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/tubeshelf", "health"]
ENTRYPOINT ["/tubeshelf"]
