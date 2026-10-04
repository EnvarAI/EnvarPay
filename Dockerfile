# Independent commerce runtime; user Agent/model/signing credentials are never bundled.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /build
COPY packages/typescript/package.json packages/typescript/package-lock.json ./
RUN npm ci --ignore-scripts
COPY packages/typescript/tsconfig.json ./
COPY packages/typescript/src ./src
COPY packages/typescript/schemas ./schemas
COPY packages/typescript/examples ./examples
COPY packages/typescript/README.md LICENSE ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production
WORKDIR /opt/envarpay
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/schemas ./schemas
COPY --from=build /build/examples ./examples
COPY --from=build /build/package.json /build/README.md /build/LICENSE ./
RUN groupadd --gid 10001 envarpay \
    && useradd --uid 10001 --gid 10001 --no-create-home envarpay \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data \
    && printf '#!/bin/sh\nexec node /opt/envarpay/dist/commerce/cli.js "$@"\n' > /usr/local/bin/envarpay \
    && chmod 755 /usr/local/bin/envarpay
USER 10001:10001
WORKDIR /data
ENTRYPOINT ["envarpay"]
CMD ["--help"]
