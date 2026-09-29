FROM envarpay:matrix-sdk
USER root
COPY --chmod=755 goose/goose /usr/local/bin/goose
COPY goose/sources.json /opt/framework-sources.json
ENV XDG_CONFIG_HOME=/runtime-home/config XDG_DATA_HOME=/runtime-home/data GOOSE_DISABLE_SESSION_NAMING=true GOOSE_MAX_TURNS=8
ENTRYPOINT ["goose"]
