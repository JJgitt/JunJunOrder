# Pin verified Docker Official Images mirrored by ECR Public to avoid Docker Hub rate limits in ACR builds.
FROM public.ecr.aws/docker/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS revision
WORKDIR /src
COPY .git .git
RUN apk add --no-cache git \
 && git config --global --add safe.directory /src \
 && git rev-parse HEAD > /source-revision

FROM public.ecr.aws/docker/library/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM public.ecr.aws/docker/library/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN rm -rf .git && npm run build

FROM public.ecr.aws/docker/library/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs && mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=dependencies --chown=nextjs:nodejs /app/node_modules/postgres ./node_modules/postgres
COPY --from=dependencies --chown=nextjs:nodejs /app/node_modules/bcryptjs ./node_modules/bcryptjs
COPY --from=revision --chown=nextjs:nodejs /source-revision ./source-revision
USER nextjs
EXPOSE 3000
CMD ["sh","-c","node scripts/bootstrap.mjs && node server.js"]
