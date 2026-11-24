# Приватный обмен PHP ↔ Node в vaulter-sheets (wire v1)

Документ-владелец формата сообщений между PHP-владельцем книги и вычислителем `@vaulter/sheets-runtime`. Транспорт (CLI, HTTP, лимиты процесса) описан в [sheets.md](sheets.md#внутренний-обмен-php-и-node), запись под блокировкой — там же в разделе «Атомарная запись». Пользовательский API (`http-v1.yaml`) и wire Office SDK ([agent-sdk.md](../agent-sdk.md)) этим документом не задаются.

**Образец** → upstream `workbook-operation` reference prototype (Univer 1.5.2, Node 24.12, PHP 8.4); контрактный гейт в этом репозитории — `scripts/ci/workbook-contract.sh`. Целевые файлы: `contracts/runtime-v1.schema.json`, `packages/runtime/src/protocol.ts`, `packages/sheets/src/Runtime/`. Схема — канон формы сообщений. Правила, которые JSON Schema выразить не может (строгий разбор, digest, политики), заданы ниже.

## 1. Кадр и строгий разбор

1. Одно сообщение — один JSON-объект UTF-8 и завершающий LF. Ответ — ровно одна строка. Невалидный UTF-8, отсутствие LF и лишние данные после объекта дают `invalid_message`. Предел сообщения в образце 8 МиБ (`limit_exceeded`).
2. Декодер обеих сторон отвергает повтор ключа объекта, нечисловые IEEE-значения (`NaN`, `Infinity`, переполнение вроде `1e400`) и вложенность глубже 256. Стандартные `JSON.parse` и `json_decode` для этого непригодны: первый молча берёт последний ключ, оба теряют разряды.
3. **Целые токены.** Токен без дробной части и экспоненты вне ±(2^53−1) принимается, только если он побайтно совпадает с ES-печатью полученного double (`String(Number(token))`). Иначе разряды потеряны, и это `invalid_message`. Примеры: `9007199254740993` отвергается, `10000000000000000` (1e16) и `123456789012345680000` принимаются. Формулировка «отвергать всё вне безопасного диапазона» была бы ошибкой: ячейка 1e16 после `save()` печатается целым токеном, и снимок стал бы неотправляемым. Координаты, `count`, `generation`, `position` дополнительно обязаны быть безопасными целыми.

## 2. Запрос

`{version:1, request_id, operation, base:{generation, position, sha256}, profile_id, workbook, commands | selector, limits?}`.

- `operation:"apply"` — непустой список `commands`, не более 64. `operation:"read"|"recalculate"` — `selector:{ranges:[{sheet_id, range}]}` без `commands`.
- `workbook` — обёртка v2 `{format_version:2, profile, native, tables}`. `tables` — привязки устойчивых ID: `{table_id, sheet_id, header_row, columns:[{column_id, column}], rows:[{row_id, row}]}`. Все координаты на wire и в `tables` нумеруются с единицы. Переход к нумерации движка с нуля происходит в одном месте адаптера (`engineIndex()` в `src/engine/univer.ts`, проверка S5).
- `limits` может только уменьшить пределы профиля (`max_commands`, `max_cells_per_command`, `calculation_timeout_ms`), но не увеличить.
- Runtime сверяет `base.sha256` с digest полученного `workbook` (`base_mismatch`), профиль (`profile_mismatch`), список ресурсов `native` с профилем (`unsupported_content`, `detail.reason:"unknown_resource"`) **до** открытия движка.

### Содержимое ячейки

Предусловие и прочитанное содержимое передаются теговым `CellContent`: `null` (пустая ячейка) | `{"number":n}` | `{"text":s}` | `{"boolean":b}` | `{"formula":"=…"}`. Ровно один тег. Голое `"expected":5` запрещено, потому что не отличает число 5, текст «5» и формулу со значением 5. Формула сравнивается по исходному тексту, а не по вычисленному значению. Значения пакетной записи (`set_values.values`) — `Literal`: `null | {number} | {text}`. Формула вводится только отдельной командой.

### Команды профиля

| `kind` | Поля | Отказы |
| --- | --- | --- |
| `set_number`, `set_text`, `set_formula` | `sheet_id, row, column, expected: CellContent`, `value` / `formula` | `precondition_failed`, `unknown_target` |
| `set_values` | `sheet_id, row, column`, прямоугольные `expected: CellContent[][]` и `values: Literal[][]` одного размера | вся область проверяется до первой записи; `limit_exceeded` по числу ячеек |
| `insert_row_before` | `sheet_id, row, count`, `new_row_ids?: {table_id: [row_id…]}` | `identity_required` |
| `fill_formula` | `sheet_id, table_id, scope: fixed_members\|current_rows, row_ids, destination_column_id, expression:{op:"subtract", left_column_id, right_column_id}, expected_destination: CellContent[]` | `unknown_target`, `precondition_failed`, `scope_changed` |

Незнакомая команда или выражение вне профиля — `unsupported_command` до экспорта. Все цели и предусловия команды разрешаются и проверяются до первой записи в движок.

**Выдача row ID.** Runtime сам ID не придумывает. Если вставка попадает внутрь логической таблицы, владелец передаёт в `new_row_ids[table_id]` ровно `count` новых, ещё не занятых ID. Иначе runtime возвращает `identity_required`. Вставка вне таблиц ID не требует. Так ID одинаковы при повторном расчёте и в журнале, а владелец может записать их в квитанцию.

**`fill_formula`.** `fixed_members` разрешает каждый `row_id` в текущую строку. Строки, вставленные позже, не затрагиваются. `current_rows` дополнительно требует, чтобы активный состав таблицы совпадал с `row_ids` (порядок из `tables`). Иначе `scope_changed` с `detail.expected/actual`, и ничего не пишется.

## 3. Ответ

- Успех `apply`/`recalculate`: `{version, request_id, ok:true, operation, base_sha256, workbook, candidate_sha256, changed_ranges, calculation:{state:"ready", source_sha256}, checks:{resources_preserved, cells}}`. `cells` — контрольное чтение изменённых ячеек `{sheet_id, a1, row, column, formula, value}` после барьера расчёта.
- Успех `read`: `{…, ok:true, operation:"read", base_sha256, calculation, data:{ranges:[{sheet_id, range, cells}]}}` без новой книги.
- Отказ: `{version, request_id|null, ok:false, error:{code, message, detail?}}`. При любом отказе копия книги в процессе уничтожается.
- `calculation.state` в v1 всегда `ready` и привязан к `candidate_sha256`. Runtime ждёт барьер `executeCalculation` + `onCalculationResultApplied(timeout)`. Кэш, прочитанный из снимка, ready не означает (сценарий 999 → 41). Тайм-аут барьера — `calculation_timeout`. Состояние `pending` в v1 на wire не передаётся.
- Ресурсы плагинов: `save()` обязан вернуть все ресурсы профиля, которые были во входе. Потеря ресурса — `unsupported_content` с `detail.reason:"resource_lost"`.

### Коды ошибок и их отображение у PHP

Публикации нет ни при одном коде. Источник — `WorkbookOwner::mapRuntimeError`.

| Код runtime | Когда | Публичный код PHP, HTTP |
| --- | --- | --- |
| `precondition_failed` | `expected` не совпал с содержимым ячейки | `version_conflict`, 409 |
| `scope_changed` | состав `current_rows` изменился | `scope_changed`, 409 |
| `unknown_target` | нет листа, строки, колонки, таблицы или row ID | `unknown_target`, 422 |
| `identity_required` | вставка внутри таблицы без `new_row_ids` или с занятым ID | `invalid_command`, 422 |
| `unsupported_command`, `unsupported_content`, `profile_mismatch` | вне профиля, неизвестный или потерянный ресурс | `unsupported_content`, 422 |
| `limit_exceeded` | размер сообщения, число команд или ячеек | `limit_exceeded`, 413 |
| `calculation_timeout` | барьер расчёта не завершился | `calculation_pending`, 503 |
| `invalid_message`, `unsupported_version`, `base_mismatch` | ошибка самого PHP | `runtime_failed`, 503 |

Ненулевой код выхода, не одна строка stdout, нарушение схемы, чужой `request_id` → `runtime_failed`, 503.

## 4. Канонизация и digest

`base.sha256`, `base_sha256`, `candidate_sha256`, `calculation.source_sha256` — SHA-256 (hex, нижний регистр) над RFC 8785 (JCS) всей обёртки `workbook`, включая `profile` и `tables`. Ключи сортируются по кодовым единицам UTF-16, числа печатаются по ES, `{}` и `[]` различаются (PHP-кодек декодирует объекты в `stdClass`). PHP и Node дают одинаковые байты на 407 векторах (проверка S4: пример RFC, кириллица, порядок UTF-16, случайные double).

Профиль чисел здесь шире, чем у digest предложения AI ([agent-sdk.md](../agent-sdk.md), п. 2 «Подготовка»): книга содержит дроби и большие double, поэтому они печатаются по ES, а не отвергаются. Это два разных digest, путать их профили нельзя.

Владелец ничему из ответа не верит без пересчёта (`WorkbookOwner::verifyCandidate`). Он проверяет: `base_sha256` равен голове, на которой запущен расчёт; собственный JCS-digest `workbook` равен `candidate_sha256`; `calculation.source_sha256` равен тому же digest; `profile` не изменился; размер в пределе Documents.

**Digest кандидата невоспроизводим, и это норма.** В Univer 1.5.2 `setNumberFormat` создаёт в `native.styles` стиль со случайным ID. Две сборки одного содержимого дают разный `candidate_sha256` (проверка S7). Apply по одному и тому же снимку без нового стиля даёт одинаковые байты (S6). Поэтому:

- идемпотентность повтора определяется отпечатком команды (`command_id` + JCS от команд, политики, If-Match, ожидаемого поколения) и сохранённой квитанцией, а не пересчётом и сравнением digest;
- повтор с тем же ключом возвращает сохранённую квитанцию без вызова runtime;
- replay журнала 6.1 применяет сохранённые байты/команды из квитанции, а не ожидает совпадения digest нового расчёта. Проверка «пересчитали — digest совпал» в приёмке 6.1 недопустима.

## 5. Политики владельца при движении головы

Расчёт идёт вне транзакции. Под блокировкой владелец повторно сравнивает generation, position и sha256 головы с основанием кандидата. Если голова сдвинулась, поведение задаёт политика команды. Политика входит в отпечаток. Vue выбирает политику сам (`policyFor` в `src/vue-client.ts`): только команды содержимого — `rebase_cells`, иначе `exact_base`. Проверка: сценарии D1–D3 в `check.mjs`, включая мутант без структурной защиты, который пишет цену груш в строку слив.

| Политика | Кто использует | Голова сдвинулась |
| --- | --- | --- |
| `exact_base` | UI по адресам A1 для структурных команд, обязателен `If-Match` | `version_conflict`, кандидат отброшен |
| `rebase_cells` | UI по адресам A1, только команды содержимого (`set_number`, `set_text`, `set_formula`, `set_values`), обязателен `If-Match` | те же команды выполняются на новой голове, runtime заново сверяет каждое `expected`. Правка другой ячейки другим пользователем — не конфликт. Изменённая ячейка — `precondition_failed` → `version_conflict`. Перебазирование запрещено (`version_conflict`, `detail.structural_receipts`), если между `If-Match` и головой есть квитанция со структурной командой на том же листе (`structural_sheets` в квитанции) или публикация без квитанции (restore, импорт): адрес A1 мог перейти к другой записи с тем же содержимым. Смена поколения — `generation_changed` |
| `revalidate_by_id` | SDK, команды по ID (`fill_formula`), `If-Match` запрещён, передаётся ожидаемое поколение | новый вызов runtime на новой голове, до 3 попыток (иначе `contention`, 503). ID разрешаются заново, `fixed_members` получает новые координаты, `current_rows` — `scope_changed`. Смена поколения — `generation_changed` |

## 6. Что подтверждает образец и что остаётся пакету

Образец проходит алгоритм на закреплённых версиях: настоящий Univer в отдельных процессах Node, PHP-владелец, барьеры через pipe, файловое хранилище с flock. Пакетная приёмка 4.2/5.1 дополнительно требует `AtomicDocumentMutation` на PostgreSQL, Drive ACL, HTTP-транспорт `server.ts`, Symfony Process, Vue-компонент в браузере, SDK-адаптер и испытание restore. Перечень — в разделе «Автономный образец и будущая приёмка пакета» журнала ревью `audits/plan-review-2026-11-20/area-3.md`.
