# Comparison-engine review — 2026-06

Ревью методологии сравнения (impact-вердикта) приложения. Источники:
`app/models/baseline.server.ts`, `app/models/recommendation.ts`,
`app/routes/api.baseline.tsx`, `app/models/pixelMetrics.server.ts`.

Вывод: исходно были две нестыковки метода (P0 — конверсия, P0b — revenue/orders
вердикта) плюс факторы, которые считались, но не влияли на вердикт. Ниже —
ranked-лист по приоритету.

> **Поправка к первой версии ревью.** В первой редакции я написал, что
> revenue/orders в вердикте уже считаются по rolling baseline — это было
> неверно. Я смотрел `api.baseline.tsx` (где baseline-дельты действительно
> считаются), но рендеримый вердикт строился из `calculateObservedChange`
> в `app.analytics.tsx` по **before/after**. Baseline лишь показывался в
> отдельной панели. См. P0b.

---

## P0b — вердикт считал revenue/orders по before/after, а не по baseline ✅ DONE (2026-06)

**Где было:** `app.analytics.tsx` — `buildRecommendation` получал
`revenueDeltaPct`/`ordersDeltaPct`/`aovDeltaPct` из `calculateObservedChange`
(before/after окно), тогда как rolling baseline считался отдельно и только
отображался. После P0 это давало смешанный вердикт: конверсия по baseline,
а revenue/orders по before/after.

**Что сделано:** для выбранного события вердикт берёт revenue/orders/AOV из
rolling baseline (`baselineData.deltaPct`, уже считается в `api.baseline.tsx`),
fallback на before/after когда нет истории (`weeksWithData=0`). В объект
вердикта добавлен `verdictBasis`, в UI — строка про источник сравнения. Удалён
мёртвый дублирующий `observedChange`-блок (источник исходной ошибки ревью).
Движок (`recommendation.ts`) не менялся — у него уже есть юнит-тесты на математику.
`tsc --noEmit` + suite 124/124 зелёные.

**Verification gap:** проводка baseline→вердикт — это UI-glue в loader-компоненте,
юнит-тестом не покрыта (дельты приходят из рантайм-fetch). Покрыто typecheck'ом
и тестами движка; ручную проверку на реальном магазине стоит сделать отдельно.

---

## P0 — нестыковка метода сравнения (конверсия)

### 1. Conversion/funnel считается по before/after, а не против baseline ✅ DONE (2026-06)
**Статус:** исправлено. `computeRollingFunnelBaseline` в `pixelMetrics.server.ts`,
`api.baseline.tsx` сравнивает actual-after vs rolling funnel baseline (fallback
на before/after только при `weeksWithData=0`), UI помечает basis Expected/Actual.
Тесты: `pixelMetrics.test.ts` (3). Suite 118/118 + typecheck зелёные.

<details><summary>исходное описание</summary>
**Где:** `api.baseline.tsx` — `fetchPixelFunnel(beforeStart→event)` vs
`fetchPixelFunnel(event→afterEnd)`; дельта через `funnelDeltaPct(before, after)`.

**Проблема:** revenue/orders сравниваются с rolling baseline (тот же слот за
4 недели — убирает сезонность), а конверсия — по наивной схеме «W до vs W после»,
которую README прямо критикует за day-of-week / hour-of-day шум. При этом
`conversionDeltaPct` имеет **право override** для theme-событий
(`recommendation.ts`: `conversionDeltaPct <= -20` → `negative/strong` в одиночку).
То есть самый влиятельный сигнал считается самым шумным методом.

**Фикс (варианты):**
- считать conversion/funnel тоже против rolling baseline того же слота, ИЛИ
- понизить override-вес conversion до тех пор, пока baseline-funnel не готов
  (например, требовать совпадения направления с orders/revenue).
</details>

---

## P1 — факторы, которые не влияют на вердикт ✅ DONE (2026-06)

**Статус:** исправлено в `recommendation.ts`. Тесты: +6 в `recommendation.test.ts`,
suite 124/124 зелёные.

### 2. pageViewsDeltaPct не входит в label/strength ✅
Сделано модификатором confidence (НЕ label-драйвером): свинг трафика ≥40% →
−15 confidence + driver «Large traffic swing… (confidence reduced)». Трафик —
внешний фактор (кампании/реферралы/сезонность), поэтому он не должен двигать
вердикт, но честно сигнализирует, что orders/revenue Δ может быть им confounded.

### 3. aovDeltaPct не входит в label/strength ✅
Заведён как нюанс label для price-событий: price-up с просадкой orders/revenue,
но ростом AOV ≥5% → `negative → mixed`; price-down с обвалом AOV ≤−10% при росте
→ `positive → mixed`. Только product-price события, пороги (±5/±10) настраиваемы.

---

## P2 — статистическая корректность baseline ✅ DONE (2026-06)

**Статус:** P2.4 и P2.5 исправлены; P2.6 — пересмотрено (поведение корректно,
добавлена документация). Движок получил два knob'а `withinNoiseBand` / `lowVolume`
(оба только режут strength до moderate + дают −confidence, label не трогают).
Тесты: +2 в `baseline.test.ts`, +4 в `recommendation.test.ts`. Suite 130/130 +
typecheck зелёные.

### 4. Нет проверки значимости ✅
`computeRollingBaseline` теперь считает популяционное σ понедельных
orders/revenue (`stdDevOrders` / `stdDevRevenue`, null при <2 недель).
`api.baseline.tsx` выставляет `withinNoiseBand`, если actual в пределах ±1σ по
ОБЕИМ метрикам → движок не даёт `strong` (cap → moderate, −15 confidence, driver
«Δ within normal weekly variance (≤1σ)»).

### 5. Нет порога по абсолютному объёму ✅
`api.baseline.tsx` выставляет `lowVolume`, если `expectedOrders` отсутствует или
`< 5`, либо `actualOrders < 5` (порог `VOLUME_FLOOR_ORDERS`, настраиваемый).
Движок: cap → moderate, −20 confidence, driver «Low volume — too few orders…».

### 6. Пустые слоты выкидываются → ПЕРЕСМОТРЕНО (поведение корректно)
Изначально считалось багом, но с учётом семантики бакетов это правильно:
`backfillLastNMinutes` пишет строку на КАЖДЫЙ 10-мин слот (включая 0/0), а live
order-webhooks создают строку только при заказе. Значит отсутствие недели —
это «период не собирали», а не «магазин ничего не продал»; считать его нулём
занизило бы expected. Текущий skip + penalty по coverage — верный выбор.
Добавлен поясняющий комментарий в `baseline.server.ts`. Поведение не менялось.

---

## P3 — атрибуция ✅ DONE (2026-06)

### 7. Overlapping events только снижают confidence ✅
Сделано: `calculateObservedChange` собирает лейблы конкурирующих событий
(`type @ HH:MM UTC`), движок (`overlappingEventLabels`) выводит их в driver
«Overlapping events (N) compete for attribution: …» с капом на 3 и «+K more».
Без лейблов — fallback на старый счётчик. Тесты: +3 в `recommendation.test.ts`.
Suite 133/133 + typecheck зелёные.

<details><summary>исходное описание</summary>
Несколько событий в одном окне не разводятся по вкладу — это честно отражено
как «no causation», но для UX-вердикта остаётся слепой зоной. Достаточно
оставить как есть, но стоит явно прокинуть список overlapping-событий в drivers,
чтобы мерчант видел, что именно конкурирует за атрибуцию.
</details>

---

## Что корректно (не трогать)
- Rolling baseline для revenue/orders — методологически верно.
- Confidence-floor на 0, честные label/strength/confidence/drivers.
- Idempotency-слои и dedup-окна — вне scope этого ревью, выглядят консистентно.
