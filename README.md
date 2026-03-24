# MyWhoosh -> Garmin

Расширение Chrome для синхронизации тренировок из MyWhoosh в Garmin Connect.

## Структура

- `browser-extension/` - unpacked Chrome extension
- `browser-extension/background/` - service worker и модули sync/auth
- `browser-extension/popup/` - popup UI
- `browser-extension/content-mywhoosh.js` - чтение MyWhoosh auth из страницы
- `tools/tail_extension_logs.ps1` - извлечение логов из storage расширения

## Установка

1. Открой `chrome://extensions`.
2. Включи `Developer mode`.
3. Нажми `Load unpacked`.
4. Выбери папку: `C:\Users\rroko\PycharmProjects\mywhoosh-garmin-sync\browser-extension`.

## Использование

1. Нажми иконку расширения.
2. Выбери режим:
   - `Sync New` - загрузить все ещё не обработанные активности
   - `Sync Latest` - загрузить только последнюю новую активность
3. Если MyWhoosh или Garmin не авторизованы, расширение само откроет вкладку входа.
4. Заверши логин в открытой вкладке. Sync продолжится автоматически.
5. Для диагностики используй:
   - `Copy Debug Logs` - скопировать лог последнего запуска
   - `Clear Cache` - очистить auth-кэш, processed-keys, статусы и логи

## Что означают результаты

- `Uploaded` - успешно загружено в Garmin
- `Duplicate` - такая активность уже есть в Garmin
- `Failed` - ошибка загрузки
- `Skipped` - пропущено в рамках текущего запуска
- `Processed` - прогресс текущего запуска

## Как сейчас работает авторизация

- MyWhoosh: расширение читает `webToken` из вкладки MyWhoosh и сохраняет его в `chrome.storage.local`.
- Garmin: расширение использует текущую web-session Chrome и получает bearer через Garmin SSO/OAuth flow.
- Логин и пароль расширение у себя не хранит.

## Сброс состояния

Если нужно заново пересчитать, что считается `new`, или сбросить сохранённые auth/session данные:

1. Нажми `Clear Cache` в popup.

Либо вручную:

1. Открой `chrome://extensions`.
2. Найди расширение.
3. Открой страницу сервис-воркера/хранилища расширения.
4. Очисти `chrome.storage.local` для этого расширения.

## Просмотр логов в консоли

```powershell
cd C:\Users\rroko\PycharmProjects\mywhoosh-garmin-sync
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\tail_extension_logs.ps1
```

Полезные фильтры:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\tail_extension_logs.ps1 -ErrorsOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\tail_extension_logs.ps1 -Tail 80
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\tail_extension_logs.ps1 -SinceMinutes 30
```
