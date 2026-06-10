# Code review — критичные пути (июнь 2026)

Ревью только на чтение, без правок кода. Фокус: HMAC-верификация вебхуков,
idempotency, worker drain, race conditions, безопасность публичных эндпоинтов.

Просмотрено: `app/routes/webhooks.*.jsx`, `app/routes/api.jobs.run.tsx`,
`app/routes/api.cron.*.tsx`, `app/routes/api.pixel.ingest.tsx`,
`app/lib/jobs.server.ts`, `app/models/workerDrain.server.ts`,
`app/models/webhookProcessors.server.ts`, `app/models/themeChangeRecorder.server.ts`,
`app/models/metricsBuckets.server.ts`.

Каждая находка помечена severity: **High** (теряем/дублируем данные или дыра в
безопасности), **Medium** (корректность в граничных режимах), **Low**
(harden / стиль / масштаб). Severity — оценка вероятности × ущерба, не приговор.

## Статус (обновлено)

Исправлено в этом проходе (все с юнит-тестами): **H1, H2, H3, M1, M2, M3, M4**.
Открыто: **L1** (constant-time секреты), **L2** (idempotency-ключ для поллинга —
снят остротой после H3), **L3** (N+1 + троттлинг в evaluate-alerts).
M3 закрыт частично: добавлены кап размера `data` и отбраковка `occurredAt` вне
±24ч; полноценный rate-limit по shop+IP требует стора (Redis/БД) и оставлен на
отдельный заход.

---

## High

### H1. Застрявшие `processing`-задачи никогда не переразбираются
`app/models/workerDrain.server.ts`

Claim переводит строки в `status='processing'`, но повторный claim выбирает
**только** `status='pending'`. Если функция упадёт/словит Vercel-таймаут между
claim и финальным `update` (completed/failed) — строка навсегда остаётся в
`processing` и больше никем не подбирается. Для backfill-лока есть
`STALE_LOCK_MS` reclaim, а здесь его аналога нет.

*Impact:* тихая потеря вебхук-события (не записывается Change). На Vercel
таймауты реальны — код сам их опасается в других местах.

*Рекомендация:* в claim-запрос добавить переразбор «протухших» processing-строк,
например `OR (status='processing' AND "startedAt" < NOW() - INTERVAL '5 min')`.
`attempts` уже инкрементится — можно заодно ввести cap (см. H2).

### H2. Транзиентный сбой = перманентный `failed`, без ретрая
`app/models/workerDrain.server.ts`

В `catch` задача помечается `status='failed'` навсегда. Поскольку дневной cron
дренит только `pending`, разовый сетевой сбой (например, `unauthenticated.admin`
или GraphQL темы моргнул) приводит к безвозвратной потере события. Различия
между «упало навсегда» (unknown topic) и «упало разок» нет.

*Impact:* потеря данных при любом транзиентном сбое процессора.

*Рекомендация:* при `attempts < N` возвращать в `pending` (для ретрая cron'ом),
при `attempts >= N` — `failed`. Опционально backoff по `startedAt`.
Перманентные ошибки (unknown topic) можно сразу в `failed`.

### H3. Гонка на 1-часовой агрегации theme_files_updated (read-modify-write без блокировки)
`app/models/webhookProcessors.server.ts` (processThemeJob, ветка themes/update)
и `app/models/themeChangeRecorder.server.ts` (pollThemeChangesForShop)

Обе функции делают: `findFirst` открытой `theme_files_updated`-строки → затем
либо `update` её, либо `create` новую. Нет ни транзакции, ни блокировки строки,
ни уникального ограничения на «одна открытая строка на (shop, themeId, час)».

Две параллельные обработки гонятся:
- обе не находят открытую строку → создают **две** (дубли в Timeline), либо
- обе нашли одну и ту же → `update` затирает друг друга (**lost update**:
  теряется часть `filesChanged` / неверный `updateCount`).

Это не теоретическая гонка: `api/cron/evaluate-alerts` сам вызывает
`pollAllActiveShops()`, а внешний шедулер параллельно бьёт в
`api/cron/poll-themes` — оба полят один и тот же магазин одновременно. Плюс
webhook themes/update может прийти в тот же момент.

*Impact:* дублирующиеся или искажённые записи изменений темы — прямо влияет на
то, что видит мерчант, и на алёрты.

*Рекомендация:* (а) обернуть find+upsert в транзакцию с блокировкой, либо
(б) ввести уникальный ключ окна (`shop, themeId, windowBucket`) и
`upsert` с merge через атомарный апдейт, либо (в) сериализовать поллинг
per-shop локом, как сделано для backfill (`tryAcquireBackfillLock`).

---

## Medium

### M1. Дедуп-окна сравнивают с `Date.now()`, а Change.occurredAt — это время события
`app/models/webhookProcessors.server.ts` (orders и themes)

Дедуп-запросы ищут `occurredAt >= Date.now() - 10s/30s/60s`, но создаваемые
строки получают `occurredAt = payload.created_at/updated_at` (время события, не
обработки). Пока worker дренит почти в реальном времени — работает. Но если
сработал дневной cron-backstop (или kickWorker не долетел), пачка задач
обрабатывается спустя минуты/часы: их `occurredAt` старые, в окно «последние
N сек от NOW» не попадают → дедуп **молча отключается**, в Timeline летят
дубли orders_create/orders_updated и повторные публикации темы.

*Impact:* дубли событий именно в деградированном режиме (когда kick не сработал
— а это как раз когда система под нагрузкой/сбоит).

*Рекомендация:* дедуп считать в координатах времени события, а не `Date.now()`
— например искать соседние Change по `entityId` в окне вокруг `occurredAt`
текущего payload, а не вокруг now.

### M2. Enqueue-сбой возвращает 200 — Shopify не повторит доставку
`app/routes/webhooks.*.jsx`

Общий `catch` отдаёт `200` на любую ошибку, включая падение
`prisma.webhookJob.create` (БД недоступна). Shopify считает доставку успешной и
**не ретраит** — событие потеряно навсегда. 200 уместен для бизнес-ошибок
обработки (она асинхронная), но не для провала самого enqueue.

*Impact:* при недоступности БД в момент доставки — безвозвратная потеря вебхука.

*Рекомендация:* различать verify (ок → не 5xx) и enqueue: если `create` упал не
по P2002 — вернуть 500, чтобы Shopify повторил. P2002 (дубль) по-прежнему 200.

### M3. `api/pixel.ingest` — публичный, без лимита объёма и размера
`app/routes/api.pixel.ingest.tsx`

Тейдофф «не подписываем pixel» задокументирован и разумен. Но: нет рейт-лимита,
нет ограничения размера `data` (пишется в JSON как есть), нет валидации, что
`occurredAt` в адекватном диапазоне. Зная любой установленный домен (а он
публичен), можно флудить `PixelEvent` — раздуть БД и отравить funnel-метрики
этого магазина.

*Impact:* целостность метрик и стоимость БД; DoS-поверхность.

*Рекомендация:* кап на размер тела/`data`, базовый rate-limit (по shop+IP),
отбраковка `occurredAt` дальше ±N часов от now, кап на число событий на окно.

### M4. `totalAmount` из pixel теряется, если пришёл строкой
`app/routes/api.pixel.ingest.tsx`

`Number.isFinite(data?.totalAmount)` для строки `"10.00"` → `false`, и так же
по `totalPrice`/`price`. Если pixel шлёт суммы строками (Shopify часто отдаёт
деньги строками) — `totalAmount` всегда `null`, выручка по pixel молча не
пишется.

*Impact:* тихая потеря revenue-сигнала из storefront.

*Рекомендация:* парсить через `Number(x)` + проверять `Number.isFinite`
результата, принимать и строковые значения. Стоит покрыть юнит-тестом.

---

## Low

### L1. Сравнение секретов не constant-time
`api.jobs.run.tsx`, `api.cron.poll-themes.tsx`, `api.cron.evaluate-alerts.tsx`

`auth === expected` — не постоянное по времени. По сети со случайным длинным
токеном риск тайминг-атаки мал, но дёшево закрыть `crypto.timingSafeEqual`.

### L2. Change-строки из поллинга без `webhookId`
`app/models/themeChangeRecorder.server.ts`

Записи из поллинга не несут `webhookId`, т.е. их idempotency держится только на
30s/1h-окнах и снапшоте. В сочетании с H3 это и даёт дубли. Если починить H3,
этого достаточно; иначе подумать про идемпотентный ключ и для поллинга.

### L3. `evaluate-alerts`: N+1 запросов + `setTimeout(250ms)` на отправку
`app/routes/api.cron.evaluate-alerts.tsx`

Последовательные `alertDelivery.findUnique` на каждую пару (rule, change) и
250 мс сон на каждую отправку. На росте магазинов/правил упрётся в Vercel-таймаут
функции. Уже частично отражено в backlog (multi-shop fan-out).

*Рекомендация:* префетч существующих deliveries одним `findMany` по списку
changeId; отправки батчить/параллелить с ограничением конкуренции.

---

## Что хорошо (чтобы не сломать при правках)

- Идемпотентность enqueue через `WebhookJob.webhookId @unique` + явная обработка
  P2002 — корректно.
- `FOR UPDATE SKIP LOCKED` в claim — правильный примитив для конкурентных воркеров
  (проблема только в отсутствии reclaim, H1).
- Backfill-лок с reclaim протухших (`STALE_LOCK_MS`) — образец, которого не
  хватает воркеру и поллингу.
- Дедуп публикации/switch темы и сжатие burst'а правок в одну строку —
  продуманная доменная логика (страдает только от гонки H3, не от самой идеи).
- `escapeHtml` в письмах алёртов — XSS в email-рендере закрыт.

---

## Предлагаемый порядок исправления

1. **H1 + H2** — reclaim протухших `processing` и ретрай транзиентных сбоев
   (одно место, `workerDrain`, максимально снижает потерю данных).
2. **H3** — сериализовать/атомизировать агрегацию темы (per-shop лок или
   уникальный ключ окна).
3. **M1** — перевести дедуп на время события.
4. **M2** — корректные коды ответа на enqueue-сбой.
5. **M3 + M4** — harden pixel-эндпоинта и фикс парсинга суммы (+ тест).
6. **L1–L3** — по возможности.

Все правки стоит сопровождать юнит-тестами в существующем стиле
(`*.test.ts`, мок Prisma) — H1/H2/M1/M4 особенно хорошо туда ложатся.
