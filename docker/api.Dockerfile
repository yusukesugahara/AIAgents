FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json biome.json ./
COPY apps ./apps
COPY agents ./agents
COPY packages ./packages
COPY .github .github
COPY docs docs
COPY README.md ./

RUN bun --no-env-file install --frozen-lockfile

USER bun

CMD ["bun", "--no-env-file", "apps/api/src/index.ts"]
