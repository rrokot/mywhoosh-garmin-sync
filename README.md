# MyWhoosh -> Garmin

Расширение Chrome для загрузки тренировок из MyWhoosh в Garmin Connect.

## Установка

1. Открой `chrome://extensions`.
2. Включи `Developer mode`.
3. Нажми `Load unpacked`.
4. Выбери папку: `C:\Users\rroko\mywhoosh-garmin-sync\browser-extension`.

## Использование

1. В том же профиле Chrome войди в:
   - MyWhoosh
   - Garmin Connect
2. Открой страницу активностей MyWhoosh.
3. Нажми иконку расширения.
4. Выбери режим:
   - `Upload New Activities` - загрузить только новые активности
   - `Upload Latest Activity` - загрузить только последнюю новую активность
   - `Copy Debug Logs` - скопировать диагностические логи

## Что означают результаты

- `Uploaded` - успешно загружено в Garmin
- `Duplicate` - такая активность уже есть в Garmin
- `Failed` - ошибка загрузки
- `Skipped` - пропущено (не новое для выбранного режима)

## Сброс истории "новых" активностей

Если нужно заново пересчитать, что считается "new":

1. Открой `chrome://extensions`.
2. Найди расширение.
3. Открой страницу сервис-воркера/хранилища расширения.
4. Очисти `chrome.storage.local` для этого расширения.

## Просмотр логов в консоли

```powershell
cd C:\Users\rroko\mywhoosh-garmin-sync
.\tail_extension_logs.bat
```

Полезные фильтры:

```powershell
.\tail_extension_logs.bat -ErrorsOnly
.\tail_extension_logs.bat -Tail 80
.\tail_extension_logs.bat -SinceMinutes 30
```
