# Niveshaay Communication Center — production image (app + worker share the image)
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate && npx next build

FROM base AS runner
ENV NODE_ENV=production
RUN useradd --system --uid 1001 ncc
COPY --from=build /app /app
USER ncc
EXPOSE 3000
# Default: web app. The worker runs the same image with `npm run worker`.
CMD ["npx", "next", "start", "-p", "3000"]
