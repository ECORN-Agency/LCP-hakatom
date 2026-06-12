# E2E-чеклист на dev-магазине Shopify

Цель: проверить слой, который юнит/интеграционные тесты не покрывают —
реальные вызовы Shopify Admin GraphQL, доставку вебхуков (HMAC), storefront
Web Pixel и сквозной поток «событие → Change → baseline → алёрт».

Тесты доказывают логику с замоканным Shopify. Этот чеклист доказывает, что
приложение работает с настоящим Shopify.

---

## 0. Подготовка

- [ ] Создать **development store** в Shopify Partner Dashboard (бесплатный).
- [ ] Залить пару товаров с вариантами и ценами; включить онлайн-канал.
- [ ] Развернуть приложение (Vercel) с боевыми env: `SHOPIFY_API_KEY/SECRET`,
      `SHOPIFY_APP_URL`, `SCOPES`, `DATABASE_URL`, `INTERNAL_SECRET`,
      `CRON_SECRET`, `RESEND_API_KEY` + `ALERT_FROM_EMAIL`.
- [ ] Установить приложение на dev-store, пройти OAuth.
- [ ] Проверить, что в БД появилась строка `Session` для шопа.

Где смотреть результаты: страницы **Home / Timeline / Analytics / Alerts /
Health** в приложении, плюс при желании таблицы Б
(`Change`, `WebhookJob`, `MetricBucket`, `PixelEvent`, `AlertDelivery`).

---

## 1. Доставка и верификация вебхуков

- [ ] **Health → Webhook queue**: после действий в магазине счётчики
      pending/processing/completed растут, failed = 0.
- [ ] Опубликовать/сменить тему → в **Timeline** появляется
      `theme_published` / `theme_switched` в течение секунд.
- [ ] Поменять цену варианта товара → `products_update` с человекочитаемым
      саммари (`price X→Y`), а не «Product updated».
- [ ] Сменить статус товара (active↔draft) → саммари содержит `status …`.
- [ ] Удалить товар → `products_delete`.
- [ ] Создать тестовый заказ → `orders_create` (а не дубль create+updated).
- [ ] Изменить/оплатить заказ → проверить, что НЕ плодятся дубли
      (M1: дедуп create↔updated работает на реальных payload'ах).
- [ ] Изменить коллекцию → `collections_update`.
- [ ] **Негатив:** дернуть webhook-URL руками с неверной подписью →
      ответ не 2xx (HMAC отверг), в Timeline ничего не появилось.

## 2. File-level видимость темы (polling)

Shopify НЕ шлёт вебхук на правки файлов в Customizer — их ловит поллинг.

- [ ] Внешний шедулер (cron-job.org) настроен на `POST /api/cron/poll-themes`
      с `Authorization: Bearer <CRON_SECRET>` каждые 5–15 мин.
- [ ] Отредактировать секцию в Customizer и сохранить → после следующего
      поллинга в Timeline появляется `theme_files_updated` с именами файлов
      (`sections/...liquid`, `config/settings_data.json`).
- [ ] Сделать 2–3 правки подряд в течение часа → они **агрегируются** в одну
      строку с `updated N×`, а не плодят N строк (H3: проверка на реальной
      гонке poll vs daily-cron).
- [ ] Дернуть `poll-themes` без/с неверным секретом → 401.

## 3. Storefront Web Pixel

- [ ] **Health → Storefront pixel**: статус `Active` (или нажать
      «Activate pixel now» и убедиться, что активировался без ошибки).
- [ ] Открыть витрину, походить по страницам, добавить в корзину, начать
      checkout → в **Analytics** (или таблице `PixelEvent`) появляются
      `page_viewed`, `product_added_to_cart`, `checkout_started` в секундах.
- [ ] Завершить заказ → `checkout_completed`, сумма распарсилась в
      `totalAmount` (M4: проверка, что строковые суммы не теряются).
- [ ] **Негатив:** POST в `/api/pixel/ingest` с `shop` несуществующего
      магазина → 403; с битым `occurredAt` или гигантским `data` → 400/413.

## 4. Baseline и рекомендации (нужна история!)

Rolling baseline сравнивает с тем же часом того же дня недели за прошлые
недели — поэтому для осмысленного результата нужен накопленный трафик.

- [ ] Прогнать backfill (Analytics → backfill, или дождаться накопления
      MetricBucket за несколько дней).
- [ ] Открыть событие в **Analytics → «Compare around event»**: видно
      before/after, rolling baseline (actual vs expected), storefront-funnel,
      и recommendation с label/strength/confidence/drivers.
- [ ] При малой истории confidence корректно показывается `low` с пометкой
      нехватки покрытия (а не уверенный вердикт на пустых данных).
- [ ] Для theme-события с заметным падением конверсии по pixel — вердикт
      склоняется к `negative` даже если заказы ещё не отреагировали
      (conversion-override).

## 5. Алёрты (email)

- [ ] **Alerts**: создать правило (email, минимальный label/confidence, окно).
- [ ] Health → «Send test email» → письмо реально приходит (Resend настроен).
- [ ] Спровоцировать событие, проходящее порог, и дождаться cron
      `evaluate-alerts` (или дернуть вручную с `CRON_SECRET`) → приходит
      письмо, в **Alerts → Recent deliveries** запись `sent`.
- [ ] Повторный прогон cron НЕ шлёт дубль того же (rule, change)
      (idempotency на `AlertDelivery`).
- [ ] Событие ниже порога → запись `skipped`, письма нет.

## 6. Надёжность / восстановление (Health-кнопки)

- [ ] **Drain queue now** → pending разгребается, completed растёт.
- [ ] Сымитировать зависший backfill → **Force release lock** снимает.
- [ ] **Re-activate pixel** после ошибки → статус снова Active.
- [ ] Проверить H1 вживую: если джоба застряла в `processing` >5 мин (напр.
      из-за таймаута), следующий drain её переподхватывает и НЕ теряет.
- [ ] Удалить приложение со стора (`app/uninstalled`) → `Session` для шопа
      удаляется; повторная установка проходит чисто.

---

## Что считаем «прошло»

Сквозной поток отработал на настоящих данных: событие в магазине → вебхук
(или поллинг) → `Change` с осмысленным саммари → видно в Timeline/Analytics →
baseline/recommendation считаются → алёрт уходит и не дублируется. Дедуп,
агрегация и pixel ведут себя как в тестах, но уже на реальных payload'ах и
реальной задержке Shopify.

Найденные расхождения — кандидаты в новые юнит/интеграционные тесты (как было
с TZ-багом reclaim).
