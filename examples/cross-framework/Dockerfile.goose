FROM rust:1.96.1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake pkg-config libssl-dev libdbus-1-dev libclang-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src/goose
COPY goose/source /src/goose
# External MCP + hosted model CLI build; no local inference/desktop/voice packages.
ENV CARGO_INCREMENTAL=0 CARGO_PROFILE_RELEASE_DEBUG=0
RUN cargo build --locked --release -j 2 -p goose-cli --bin goose \
    --no-default-features --features rustls-tls
FROM envarpay:matrix-sdk
COPY --from=build /src/goose/target/release/goose /usr/local/bin/goose
COPY goose/source.json /opt/goose-source.json
ENV XDG_CONFIG_HOME=/runtime-home/config XDG_DATA_HOME=/runtime-home/data \
    GOOSE_DISABLE_SESSION_NAMING=true GOOSE_MAX_TURNS=8
ENTRYPOINT ["goose"]
