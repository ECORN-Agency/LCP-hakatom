# LSP Analizer

Business Impact Analyzer for Shopify — embedded admin app that captures shop
events (theme publish/update, products, orders, collections) and shows the
metric impact "around" each event with an honest, rule-based confidence label.
No causal claims, no ML — just early signals with explicit data-coverage status.

Originally a hackathon MVP (Dec 2025), now being grown into a real product.

## Stack

- **Runtime:** Node 20+, deployed on Vercel (serverless functions)
- **Framework:** React Router 7 + Vite 6
- **UI:** Shopify Polaris web components + App Bridge React
- **Auth/embed:** `@shopify/shopify-app-react-router` v1
- **DB:** PostgreSQL on Neon, accessed through Prisma 6
- **Logging:** Pino (JSON in prod, pretty in dev)

## Project layout

```
app/
  logger.server.ts              Pino logger (structured JSON in prod)
  db.server.js                  Prisma client singleton
  shopify.server.js             App Bridge / auth config
  models/
    recommendation.ts           Pure rule-based recommendation engine
    metricsBuckets.server.ts    10-min bucket math + backfill from Shopify
  routes/
    app._index.jsx              -> renders Timeline
    app.timeline.tsx            Event log + manual event creation
    app.analytics.tsx           Backfill + "compare around event" + recs
    api.changes.manual.jsx      POST endpoint for manual events
    webhooks.themes.jsx         themes/publish, themes/update
    webhooks.products.jsx       products/create|update|delete
    webhooks.orders.jsx         orders/create|updated
    webhooks.collections.jsx    collections/create|update|delete
    webhooks.app.*              uninstall, scopes_update (housekeeping)
prisma/
  schema.prisma                 Session / Change / MetricBucket
scripts/
  clear-db.js                   Truncate Change and MetricBucket (dev only)
shopify.app.toml                App URL, scopes, webhook subscriptions
```

### Data model

- **Change** — every captured event: `shop`, `type`, `entityType`, `entityId`,
  `summary`, `payload` (raw webhook), `occurredAt`. Indexed on `(shop, occurredAt)`.
- **MetricBucket** — 10-minute aggregate per shop: `orders`, `revenue`,
  `bucketAt`, `bucketMinutes`. Unique `(shop, bucketAt)`. Stored under the
  legacy table name `DailyMetric` via `@@map` until a proper rename migration.
- **Session** — Shopify session storage, managed by the Prisma session adapter.

## Local development

### Prerequisites

- Node 20.19+ (or 22.12+)
- A Postgres URL (Neon free tier is enough)
- A Shopify Partner organisation + a development store
- Shopify CLI installed globally: `npm i -g @shopify/cli`

### Setup

```bash
# 1. Install
npm install

# 2. Generate Prisma client and push schema to your DB
npx prisma generate
npx prisma db push

# 3. Configure env
cp .env.example .env
# Then fill in real values — see "Environment variables" below.

# 4. Link the local code to your Shopify app (first time only)
npx shopify app config link

# 5. Run dev server (opens a tunnel, registers webhooks on Partner Dashboard)
npm run dev
```

The dev tunnel URL is auto-injected as `SHOPIFY_APP_URL`. We deliberately set
`automatically_update_urls_on_dev = false` in `shopify.app.toml` so that local
dev no longer overwrites the production URL in Partner Dashboard.

### Useful scripts

| Command | What it does |
|---|---|
| `npm run dev` | Shopify CLI dev tunnel + Vite hot reload |
| `npm run build` | Production build (React Router) |
| `npm run start` | Serve `./build/` |
| `npm run typecheck` | RR typegen + `tsc --noEmit` |
| `npm run lint` | ESLint over the repo |
| `npx prisma studio` | Visual DB browser at `localhost:5555` |
| `node scripts/clear-db.js` | Wipe `Change` + `MetricBucket` (dev only!) |

## Environment variables

All required. Copy `.env.example`, then fill in.

| Variable | Where it comes from |
|---|---|
| `SHOPIFY_API_KEY` | Partner Dashboard → app → Configuration → Client ID |
| `SHOPIFY_API_SECRET` | Same page → Client secret (use Reveal/Rotate) |
| `SHOPIFY_APP_URL` | Your public URL (prod: Vercel; dev: auto-injected by CLI) |
| `SCOPES` | Mirror of `[access_scopes]` in `shopify.app.toml` |
| `DATABASE_URL` | Neon Postgres connection string (use the **pooled** one) |
| `LOG_LEVEL` | Optional: `debug` / `info` / `warn` / `error` (default: info in prod) |

Never commit `.env`. It is in `.gitignore`. If a secret leaks in git history,
rotate `SHOPIFY_API_SECRET` in Partner Dashboard and change `DATABASE_URL` in Neon.

## Deployment

### Vercel (the web app)

1. Vercel project is connected to `ECORN-Agency/LCP-hakatom`. Pushes to `main`
   auto-deploy.
2. Build settings:
   - Install Command: `npm install && npx prisma generate`
   - Build Command: `npm run build` (default)
   - Output Directory: `build` (default)
3. Environment Variables in Vercel Settings must mirror `.env` (see table above),
   plus `NODE_ENV=production` is set by Vercel automatically.

After changing env vars in Vercel, trigger a Redeploy — env updates don't apply
to in-flight deployments.

### Shopify Partner Dashboard (app config)

`shopify.app.toml` is the source of truth for App URL, redirect URLs, scopes,
and webhook subscriptions. To push it to Partner Dashboard:

```bash
npx shopify app deploy
```

This **does not** deploy code — it only updates the app's metadata in Partner
Dashboard. The CLI will show a diff and ask for confirmation. After running
`deploy`, Shopify re-registers webhooks at the new URLs for all installed shops.

### Neon (Postgres)

Schema lives in `prisma/schema.prisma`. To apply changes to the prod DB:

```bash
# Locally, with prod DATABASE_URL in your shell
npx prisma db push
```

This project currently uses `db push` rather than full migrations. When the
data model stabilises, switch to `prisma migrate dev` / `migrate deploy` and
check in proper migration history.

## Logging

We use [Pino](https://getpino.io/) for structured logs (`app/logger.server.ts`).
In production it emits JSON, which Vercel's Function Logs UI parses so you can
filter by `shop`, `topic`, `entityId`, etc.

```ts
import { logger } from "../logger.server";

// Always pass structured fields first, human message second.
logger.info({ shop, topic, entityId }, "webhook received");
logger.error({ err: error, shop }, "webhook failed");

// For a stable per-request context, use child loggers:
const log = logger.child({ route: "webhooks.orders" });
log.info({ shop, topic }, "received");
```

Never string-interpolate context into the message — it breaks log filtering.

## Webhook flow

1. Shopify sends `POST /webhooks/<topic>` to our Vercel app.
2. `authenticate.webhook(request)` verifies HMAC, returns `{topic, shop, payload}`.
3. The route handler builds a `Change` row (with optional `changeDetails` for
   price changes / theme switches) and inserts into Postgres.
4. Naive same-shop / same-entity dedup is done in 10s / 60s / 5min windows
   depending on event type. Proper HMAC-id idempotency is on the Phase 2 backlog.

## What's still on the backlog

See the LSP presentation for product context. Current short list:

- **Idempotency** via `X-Shopify-Webhook-Id` (replace timer-based dedup).
- **Pagination** in `fetchOrdersStats` (currently caps at 250 orders per bucket).
- **Background queue** for webhook handlers (move DB write off the request).
- **Rolling baseline** (compare actual vs same DoW × hour over last N weeks).
- **Storefront metrics** via Web Pixels API (conversion, Web Vitals — real
  theme-publish signal).
- **Alerts** when a rule fires `strong_negative` with medium+ confidence.

## License

Proprietary — ECORN Agency.
