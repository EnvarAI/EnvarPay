# Agent-independent service image. No Hermes/OpenClaw/model runtime is bundled.
FROM python:3.13-slim AS build
WORKDIR /build
COPY pyproject.toml README.pypi.md LICENSE ./
COPY src ./src
RUN python -m pip wheel --no-cache-dir --wheel-dir /wheels ".[task]"

FROM python:3.13-slim
COPY --from=build /wheels /wheels
RUN python -m pip install --no-cache-dir --no-index --find-links=/wheels "envarpay[task]" \
    && python -m pip check \
    && groupadd --gid 10001 envarpay \
    && useradd --uid 10001 --gid 10001 --no-create-home envarpay \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data
USER 10001:10001
WORKDIR /data
ENTRYPOINT ["envarpay"]
CMD ["--help"]
