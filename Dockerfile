FROM node:16 as builder

WORKDIR /calcom
ARG NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SLOTS_PROXY_URL
ARG GLOBAL_WEBHOOK_URL
ARG GOOGLE_API_CREDENTIALS
ARG NEXT_PUBLIC_LICENSE_CONSENT
ARG CALCOM_TELEMETRY_DISABLED
ARG DATABASE_URL
ARG NEXTAUTH_SECRET=secret
ARG CALENDSO_ENCRYPTION_KEY=secret
ARG MAX_OLD_SPACE_SIZE=4096
ARG ENVIRONMENT
ARG NEXT_PUBLIC_SENTRY_DSN
ARG SENTRY_AUTH_TOKEN

ENV NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL \
    NEXT_PUBLIC_WEBSITE_URL=$NEXT_PUBLIC_WEBAPP_URL \
    NEXT_PUBLIC_SLOTS_PROXY_URL=$NEXT_PUBLIC_SLOTS_PROXY_URL \
    GLOBAL_WEBHOOK_URL=$GLOBAL_WEBHOOK_URL \
    GOOGLE_API_CREDENTIALS=$GOOGLE_API_CREDENTIALS \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_LICENSE_CONSENT=$NEXT_PUBLIC_LICENSE_CONSENT \
    CALCOM_TELEMETRY_DISABLED=$CALCOM_TELEMETRY_DISABLED \
    DATABASE_URL=$DATABASE_URL \
    ENVIRONMENT=$ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN \
    NEXTAUTH_SECRET=${NEXTAUTH_SECRET} \
    CALENDSO_ENCRYPTION_KEY=${CALENDSO_ENCRYPTION_KEY} \
    NODE_OPTIONS=--max-old-space-size=${MAX_OLD_SPACE_SIZE} \
    GOOGLE_LOGIN_ENABLED=true \
    SENTRY_IGNORE_API_RESOLUTION_ERROR=1

COPY package.json yarn.lock turbo.json ./
COPY apps/web ./apps/web
COPY packages ./packages

RUN yarn config set network-timeout 1000000000 -g && \
    yarn install --frozen-lockfile

RUN yarn build

FROM node:16 as runner

WORKDIR /calcom
ENV NODE_ENV production

RUN apt-get update && \
    apt-get -y install netcat sendmail && \
    rm -rf /var/lib/apt/lists/* && \
    npm install --global prisma

COPY package.json yarn.lock turbo.json ./
COPY --from=builder /calcom/node_modules ./node_modules
COPY --from=builder /calcom/packages ./packages
COPY --from=builder /calcom/apps/web ./apps/web
COPY --from=builder /calcom/packages/prisma/schema.prisma ./prisma/schema.prisma
COPY scripts scripts

EXPOSE 3000
CMD ["/calcom/scripts/start.sh"]
