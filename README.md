# LSP Analizer

Shopify-приложение, которое отвечает на один вопрос: **«какое из моих
изменений в магазине помогло или навредило продажам?»**.

Каждое редактирование темы, изменение цены, добавление товара и заказ
автоматически логируется. Для каждого события приложение сравнивает «после»
с «нормальным паттерном вашего магазина» (тот же час того же дня недели за
последние 4 недели) и показывает реальный impact на conversion, выручку и
заказы. Если что-то выглядит плохо — приходит email-алёрт.

Начинался как хакатон-MVP в декабре 2025, теперь полноценный продуктовый
каркас. Не «AI-аналитика» с чёрным ящиком — все рекомендации на rule-based
движке с явной маркировкой уверенности и drivers.

---

## Что приложение делает (для PM / merchant)

### Главные разделы

- **Home (`/app/`)** — обзор: события за 24h / 7d, статус Web Pixel,
  количество активных алёртов, последнее изменение, навигация в остальные
  разделы.
- **Timeline (`/app/timeline`)** — лента всех захваченных событий, фильтры
  по типу и времени, поиск по тексту. Можно добавлять ручные пометки.
- **Analytics (`/app/analytics`)** — для каждого события: comparison
  «до/после», **rolling baseline** (actual vs expected по prior 4 weeks
  same-slot), **Storefront funnel** (page views → cart adds → checkout
  → completion), recommendation с drivers.
- **Alerts (`/app/alerts`)** — настройка правил-уведомлений по email
  (Resend). История последних доставок.
- **Health (`/app/health`)** — диагностика: webhook queue, per-topic
  counts, статус Pixel, backfill state, alert deliveries, scale-stats.
  Кнопки «Drain queue / Re-activate pixel / Force release lock / Send
  test email» для ручного восстановления.

### Что отличает от обычной аналитики

1. **Rolling baseline убирает шум сезонности.** Не сравниваем «час до
   vs час после» (попадание в обед vs ночь даёт случайный результат),
   а сравниваем actual с тем же часом того же DoW за последние 4 недели.
2. **File-level visibility темы.** Видно не «тема изменена», а
   **«изменены `sections/header.liquid`, `config/settings_data.json`»**.
3. **Real-time storefront-сигнал.** Web Pixel в storefront sandbox шлёт
   page_viewed / cart_started / checkout_completed в секундах — задолго
   до оформления заказов.
4. **Честность интерпретации.** Каждая рекомендация показывает:
   label (`positive` / `negative` / `mixed` / `neutral`), strength
   (`strong` / `moderate`), confidence (`low` / `medium` / `high`),
   drivers (на чём именно основан вывод).

### Что приложение НЕ делает

- Не делает причинно-следственных выводов. «Это сломало conversion» —
  никогда. «Видно падение conversion рядом с этим событием, confidence
  medium» — да.
- Не использует ML / LLM. Pure rule-based logic. Каждая ветка решений
  явная и аудитируемая.
- Не модифицирует магазин. Только read-only мониторинг и email-алёрты.
- Не отслеживает установку других приложений на магазин (Shopify API
  этого не отдаёт; косвенно ловим через изменения в `settings_data.json`
  когда мерчант включает app embed в Customizer).

---

## Стек

- **Runtime:** Node 20+, Vercel serverless functions
- **Framework:** React Router 7 + Vite 6
- **UI:** Polaris web components + App Bridge 4
- **Auth/embed:** `@shopify/shopify-app-react-router` v1
- **DB:** PostgreSQL на Neon, через Prisma 6
- **Logging:** Pino (JSON в prod, pretty-print в dev)
- **Email:** Resend (для alert notifications)
- **External scheduler:** cron-job.org (для near-realtime theme polling),
  Vercel daily cron как backstop

---

## Архитектура

### Поток событий

```
┌─ Shopify webhook ─────────────────────────────────────────┐
│  POST /webhooks/{themes,products,orders,collections}      │
│  ↓                                                         │
│  verify HMAC → insert WebhookJob → fire-and-forget kick   │
│  → 200 OK (синхронный response Shopify'у в <500ms)        │
└────────────────────────────────────────────────────────────┘
                ↓
┌─ Worker drain ────────────────────────────────────────────┐
│  POST /api/jobs/run  (kicked from handler OR daily cron)  │
│  ↓                                                         │
│  FOR UPDATE SKIP LOCKED — claim pending jobs              │
│  ↓                                                         │
│  processWebhookJob() dispatcher по topic:                  │
│    themes/*    → snapshot diff + 1h aggregation           │
│    products/*  → ProductSnapshot diff + price recs        │
│    orders/*    → dedup create vs updated                  │
│    collections → simple insert                            │
│  ↓                                                         │
│  Change row в БД                                          │
└────────────────────────────────────────────────────────────┘

┌─ Theme polling (external) ───────────────────────────────┐
│  cron-job.org каждые 15 мин                              │
│  POST /api/cron/poll-themes                              │
│  ↓                                                        │
│  Для каждого active shop:                                │
│    unauthenticated.admin(shop) → theme.files GraphQL     │
│    → diff vs ThemeSnapshot → write Change                │
│  (Покрывает Customizer-saves — Shopify не шлёт webhook   │
│   на изменение файлов темы)                              │
└───────────────────────────────────────────────────────────┘

┌─ Storefront pixel ───────────────────────────────────────┐
│  Web Pixel extension (sandbox iframe)                    │
│  subscribes to standard analytics events                 │
│  → POST /api/pixel/ingest → PixelEvent row               │
└───────────────────────────────────────────────────────────┘

┌─ Alert evaluation ───────────────────────────────────────┐
│  Vercel daily cron 12:00 UTC + opt cron-job.org каждый ч │
│  POST /api/cron/evaluate-alerts                          │
│  ↓                                                        │
│  drainWebhookJobs() backstop                             │
│  pollAllActiveShops() backstop                           │
│  для каждого active AlertRule:                           │
│    find recent Change rows → evaluateChange →            │
│    ruleMatches → sendEmail (Resend) → AlertDelivery row  │
└───────────────────────────────────────────────────────────┘
```

### Слои идемпотентности

1. **WebhookJob.webhookId @unique** — Shopify-ретрай уже-вставленной
   доставки получает P2002, тихо ack.
2. **Change.webhookId @unique** — даже если job каким-то образом
   запустится дважды, Change row не задублируется.
3. **AlertDelivery `unique(ruleId, changeId)`** — один алёрт никогда
   не отправится дважды.
4. **`FOR UPDATE SKIP LOCKED`** на claim'е jobs — параллельные worker'ы
   не возьмут одну строку.
5. **Per-shop backfill lock** (`ShopConfig.backfillStartedAt`) — двое не
   запустят дублирующий бэкфилл одновременно.

### Honest signals: пороги в rule engine

`buildRecommendation()` в `app/models/recommendation.ts` принимает
revenueDeltaPct / ordersDeltaPct / aovDeltaPct / conversionDeltaPct +
coverage + overlappingEvents + partialData, возвращает:

- **label**: `positive` / `negative` / `mixed` / `neutral`
- **strength**: `strong` / `moderate`
- **confidence**: `low` (<60) / `medium` (60–80) / `high` (≥80)
- **tone**: `success` / `attention` / `critical` / `warning` / `info`
- **text**: human-readable вывод
- **drivers**: list of explanatory bullets

Confidence стартует со 100, вычитается за: противонаправленные
revenue/orders (–30), overlapping events (–20), partial data (–20),
null deltas (–15…–25), missing coverage (–15 на сторону). Floor at 0.

---

## Структура проекта

```
app/
  logger.server.ts                Pino structured logger
  db.server.js                    Prisma client singleton
  shopify.server.js               App Bridge / auth config
  lib/
    shopifyGraphql.server.ts      Wrapper с retry/pacing для Admin API
    email.server.ts               Resend wrapper с retry на 429
    jobs.server.ts                kickWorker() fire-and-forget
  models/
    recommendation.ts             Pure rule-based engine (shared)
    metricsBuckets.server.ts      10-min bucket math + Shopify backfill
    productDiff.server.ts         Product snapshot diff helpers
    themeDiff.server.ts           Theme.files diff helpers
    themeChangeRecorder.server.ts pollThemeChangesForShop (polling)
    pixelMetrics.server.ts        Storefront funnel aggregation
    pixelActivation.server.ts     webPixelCreate idempotent helper
    baseline.server.ts            Rolling baseline computation
    alertEvaluation.server.ts     Server-side evaluateChange + ruleMatches
    webhookProcessors.server.ts   Topic-specific processors (used by worker)
    workerDrain.server.ts         FOR UPDATE SKIP LOCKED job claim loop
  routes/
    _index/route.jsx              Root → always redirects to /app
    install.jsx                   Public marketing landing
    app.jsx                       Embedded layout + ui-nav-menu
    app._index.jsx                Home page (overview + nav cards)
    app.timeline.tsx              Event log + manual events
    app.analytics.tsx             Compare-around-event + baseline + funnel
    app.alerts.tsx                Alert rules CRUD + delivery history
    app.health.tsx                Diagnostic dashboard + admin actions
    api.changes.manual.jsx        POST for manual events
    api.baseline.tsx              GET baseline+actual+funnel для event
    api.pixel.ingest.tsx          POST from Web Pixel extension
    api.jobs.run.tsx              Worker drain (auth: INTERNAL/CRON_SECRET)
    api.cron.evaluate-alerts.tsx  Daily Vercel cron — alerts + drain + poll
    api.cron.poll-themes.tsx      External cron (cron-job.org) — file diffs
    webhooks.themes.jsx           themes/publish, themes/update → enqueue
    webhooks.products.jsx         products/create|update|delete → enqueue
    webhooks.orders.jsx           orders/create|updated → enqueue
    webhooks.collections.jsx      collections/* → enqueue
    webhooks.app.uninstalled.jsx  Session cleanup
    webhooks.app.scopes_update.jsx Scope sync to Session
extensions/
  lsp-storefront-pixel/           Web Pixel extension (sandbox JS)
prisma/
  schema.prisma                   All Prisma models
scripts/
  clear-db.js                     Truncate Change + MetricBucket (dev only)
.github/workflows/
  poll-themes.yml                 Optional GitHub Actions schedule
shopify.app.toml                  App URL, scopes, webhook subscriptions
vercel.json                       Daily cron for /api/cron/evaluate-alerts
```

### Data model

| Модель | Назначение |
|---|---|
| `Session` | Shopify session storage (Prisma adapter) |
| `Change` | Каждое захваченное событие. Уникальный `webhookId` |
| `MetricBucket` | 10-мин агрегаты orders/revenue (legacy table name `DailyMetric`) |
| `ProductSnapshot` | Последнее известное состояние продукта (для diff) |
| `ThemeSnapshot` | Последний известный file-listing темы (для diff) |
| `PixelEvent` | Storefront-события от Web Pixel |
| `AlertRule` | Конфигурируемые правила email-алёртов |
| `AlertDelivery` | Audit log отправленных писем (unique на rule+change) |
| `WebhookJob` | Очередь входящих webhook'ов (status: pending/processing/completed/failed) |
| `ShopConfig` | Per-shop state: pixel activation, backfill lock, last errors |

---

## Локальная разработка

### Что нужно

- Node 20.19+ (или 22.12+)
- PostgreSQL connection string (Neon free tier подойдёт)
- Shopify Partner org + development store
- Shopify CLI: `npm i -g @shopify/cli`

### Setup

```bash
npm install
cp .env.example .env
# Заполни значения — см. "Environment variables" ниже.

npx prisma generate
npx prisma db push

npx shopify app config link
npm run dev
```

Dev tunnel URL CLI инжектит как `SHOPIFY_APP_URL`. В `shopify.app.toml`
стоит `automatically_update_urls_on_dev = false` — local dev НЕ перепишет
production-URL в Partner Dashboard.

### Команды

| Command | What |
|---|---|
| `npm run dev` | Shopify CLI tunnel + Vite |
| `npm run build` | Production build (React Router) |
| `npm run start` | Serve `./build/` |
| `npm run typecheck` | RR typegen + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | Vitest — unit-сьют (один прогон) |
| `npm run test:watch` | Vitest в watch-режиме |
| `npm run hooks:install` | Включить git pre-push хук (см. ниже) |
| `npx prisma studio` | Visual DB browser |
| `node scripts/clear-db.js` | Wipe Change + MetricBucket (dev only) |

---

## Тесты

Unit-тесты на [Vitest](https://vitest.dev). Покрывают **логику ядра** — ту,
где баг тихо искажает вердикт для мерчанта или дублирует данные, а не падает
с ошибкой. Слой с БД/конкурентностью тестируется с замоканным Prisma:

| Файл | Что проверяет |
|---|---|
| `app/models/recommendation.test.ts` | rule engine: label / strength / confidence / tone, conversion-override для theme-событий, тексты по направлению цены, drivers |
| `app/models/productDiff.test.ts` | проекция webhook-payload, дедуп ghost-апдейтов, диффы цены / стока / статуса |
| `app/models/themeDiff.test.ts` | added / modified / removed файлы, checksum vs fallback на `updatedAt` |
| `app/models/baseline.test.ts` | rolling baseline: усреднение по неделям, пропуск пустых, null при отсутствии истории, AOV edge-cases (Prisma замокан) |
| `app/models/metricsBuckets.test.ts` | UTC-нормализация в 10-минутные бакеты, иммутабельность входа |
| `app/models/webhookProcessors.test.ts` | роутинг топиков + throw на неизвестном; дедуп orders create/updated; product create/update/delete/first-obs/ghost; theme non-main skip, publish dedup, publish create, update double-fire (Prisma + admin замоканы) |
| `app/models/workerDrain.test.ts` | `drainWebhookJobs`: пустая очередь, успешный батч (completed), изоляция упавшей задачи (failed + errorMessage), truncation до 500 символов, проброс batch size в claim-query |

```bash
npm run test          # один прогон (~1s)
npm run test:watch    # перезапуск при изменениях
```

Конфиг — `vitest.config.ts` (отдельный от `vite.config.js`: без
`reactRouter()`-плагина, node-окружение). Тестируется только pure-логика без
сети и БД — серверные зависимости (`prisma`, `logger`, GraphQL-wrapper)
мокаются через `vi.mock`.

### Pre-push git hook

Тесты гоняются автоматически **перед каждым `git push`** — бесплатно, без
CI-сервиса. Хук версионируется в репозитории (`.githooks/pre-push`) и
подключается через `core.hooksPath`. Так как git не клонирует хуки сам,
каждый разработчик после `git clone` выполняет один раз:

```bash
npm run hooks:install   # = git config core.hooksPath .githooks
```

Если push красный — он блокируется. Обойти разово (например, WIP-ветка):

```bash
git push --no-verify
```

---

## Environment variables

| Variable | Required | Source |
|---|---|---|
| `SHOPIFY_API_KEY` | yes | Partner Dashboard → app → Client ID |
| `SHOPIFY_API_SECRET` | yes | Same page → Client secret |
| `SHOPIFY_APP_URL` | yes | Public URL (prod: Vercel; dev: CLI inject) |
| `SCOPES` | yes | Mirror `[access_scopes]` в `shopify.app.toml` |
| `DATABASE_URL` | yes | Neon Postgres (use **pooled** connection) |
| `INTERNAL_SECRET` | yes | Random hex 32 — для kickWorker → /api/jobs/run |
| `CRON_SECRET` | yes | Random hex 32 — для cron-endpoints |
| `RESEND_API_KEY` | optional | https://resend.com — без неё email no-op'ит |
| `ALERT_FROM_EMAIL` | optional | `onboarding@resend.dev` для теста |
| `LOG_LEVEL` | optional | `debug` / `info` / `warn` / `error` |

Сгенерировать секреты:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Никогда не коммить `.env`. Если просочился — ротировать `SHOPIFY_API_SECRET`
в Partner Dashboard, регенерировать `DATABASE_URL` в Neon.

---

## Deployment

### Vercel (приложение)

Проект подключён к `ECORN-Agency/LCP-hakatom`. Push в `main` → auto-deploy.

Build settings:
- Install Command: `npm install && npx prisma generate`
- Build Command: `npm run build`
- Output Directory: `build`

Environment Variables в Vercel = `.env` (см. таблицу выше). После смены env
обязательно **Redeploy** — env не подхватывается на лету.

### Shopify Partner Dashboard (app config)

`shopify.app.toml` — источник правды для App URL, redirect URLs, scopes,
webhook subscriptions. Чтобы пушнуть в Partner Dashboard:

```bash
npx shopify app deploy
```

Это **не деплоит код** — только обновляет metadata приложения. CLI покажет
diff и попросит подтверждение. После deploy Shopify пере-регистрирует
webhooks на новых URL для всех установленных магазинов.

### Web Pixel extension

При первом открытии приложения мерчантом — `ensurePixelActivated()` в
loader `app.jsx` вызывает `webPixelCreate` мутацию идемпотентно и пишет
`ShopConfig.pixelActivatedAt`. Если активация упала — кнопка
**Re-activate pixel** на `/app/health` или `/app/alerts` запускает заново
через `resetAndReactivatePixel`.

### Neon (Postgres)

```bash
npx prisma db push
```

Использует `db push` вместо полных миграций пока схема активно меняется.
Когда стабилизируется — перейти на `prisma migrate dev` / `migrate deploy`.

---

## Cron / background jobs

### Vercel daily cron (built-in)

`vercel.json` объявляет один daily cron `0 12 * * *` на
`/api/cron/evaluate-alerts`. На Hobby plan это **единственный** доступный
встроенный cron. Endpoint делает три вещи:

1. `drainWebhookJobs()` — добивает застрявшие WebhookJobs.
2. `pollAllActiveShops()` — fetches theme.files для всех shops, diff'ит.
3. Для каждого enabled AlertRule — оценивает recent Change rows, шлёт
   email при матче.

### External scheduler (cron-job.org) — рекомендуется

Для near-realtime детекта Customizer-saves (которые Shopify не шлёт как
webhook) настроить внешний планировщик:

1. cron-job.org → Create cronjob:
   - URL: `https://lcp-hakatom.vercel.app/api/cron/poll-themes`
   - Method: POST
   - Headers: `Authorization: Bearer <CRON_SECRET>`
   - Schedule: every 15 minutes
2. Готово. Endpoint аутентифицируется тем же `CRON_SECRET` что и Vercel
   built-in cron.

GitHub Actions workflow тоже подготовлен (`.github/workflows/poll-themes.yml`)
— требует только `CRON_SECRET` в repo secrets. Подходит если репо public
или org-billing настроен.

---

## Webhook flow в деталях

1. Shopify шлёт `POST /webhooks/<topic>` на Vercel.
2. `authenticate.webhook(request)` верифицирует HMAC, возвращает
   `{topic, shop, payload}`.
3. Handler читает `X-Shopify-Webhook-Id`, вставляет `WebhookJob` row с
   этим как unique key (P2002 → silent ack at duplicate).
4. `kickWorker()` — fire-and-forget POST на `/api/jobs/run` с
   `INTERNAL_SECRET`. Handler не ждёт ответа.
5. Возвращает 200 в течение ~50-200ms.

Worker (`/api/jobs/run`):

1. `drainWebhookJobs()` — claim до 25 pending jobs атомарно через
   `FOR UPDATE SKIP LOCKED`.
2. Для каждой → `processWebhookJob({shop, topic, webhookId, payload})`.
3. `normalizeTopic()` приводит `THEMES_UPDATE` / `themes/update` к
   единому формату.
4. Topic-specific processor:
   - **themes/publish** → возможный switch detect, Change row, snapshot.
   - **themes/update** → 30s suppression если recent publish,
     fetch theme.files, diff vs ThemeSnapshot, 1h aggregation в
     существующий `theme_files_updated` row или новый.
   - **products/update** → ProductSnapshot diff с price/inventory/title,
     suppress empty diffs, rich `changeDetails` если есть изменения.
   - **orders/create|updated** → dedup в 10s window.
   - **collections/*** → simple insert.
5. Mark job `completed` или `failed` с errorMessage.

### Dedup / aggregation windows

| Topic | Logic |
|---|---|
| `orders/create` после недавнего `orders/updated` (10s) | Replace updated с create |
| `orders/updated` после недавнего `orders/create` (10s) | Suppress (covered by create) |
| `themes/update` после `theme_published`/`theme_switched` (30s) | Suppress (publish double-fire) |
| `theme_files_updated` для same theme в последний 1h | Aggregate в существующую Change row, увеличить `updateCount`, merge `filesChanged` |

---

## Logging

Pino (`app/logger.server.ts`). JSON в prod (читается Vercel Function Logs UI
для фильтра по полям), pretty в dev.

```ts
import { logger } from "../logger.server";

// Structured fields первым аргументом, message строкой вторым:
logger.info({ shop, topic, entityId }, "webhook received");
logger.error({ err: error, shop }, "webhook failed");

// Stable per-route context через child:
const log = logger.child({ route: "webhooks.orders" });
log.info({ shop, topic }, "received");
```

Никогда не string-interpolate context в message — это ломает filtering.

---

## Health / диагностика

`/app/health` (только для админов / dev) — single-page обзор:

- **Webhook queue (24h):** pending / processing / completed / failed counts,
  recent failed jobs с error.
- **Webhooks received per topic (24h):** per-topic counter, `silent` badge
  если 0.
- **Storefront pixel:** active/inactive, last error, breakdown PixelEvent
  по eventName.
- **Backfill:** in-flight detection + force-release-lock.
- **Alert deliveries (24h):** sent / failed / skipped counts.
- **Scale:** total Change / MetricBucket / PixelEvent rows.

Кнопки: `Drain queue now`, `Re-activate pixel`, `Force release lock`,
`Send test email`.

---

## Что в backlog (по приоритету)

- **App Store readiness (Phase 3.5)** — Billing API, listing copy,
  screenshots, demo-видео, прохождение App Review. Только если идём
  публично.
- **Bulk-operations API для 7d backfill** — сейчас warning'ает что
  «7d может попасть в Vercel timeout». Решается через
  `bulkOperationRunQuery` (один async query вместо 1008 sequential).
- **Script tags polling** — для частичной видимости установки сторонних
  apps. Не killer feature, делается когда упрёмся в случай.
- **Multi-shop fan-out** — когда `pollAllActiveShops` начнёт упираться
  в Vercel timeout (~30-50 shops), разбить на per-shop jobs через
  Inngest / QStash.
- **Облачный CI** — пока тесты гоняются локальным pre-push хуком (см.
  раздел «Тесты»), т.к. Actions в организации требуют биллинг. Когда
  будет доступно — добавить `.github/workflows/ci.yml` (lint + typecheck
  + test на каждый PR) как backstop к локальному хуку.

---

## License

Proprietary — ECORN Agency.
