# MyWhoosh -> Garmin

Расширение Chrome для синхронизации тренировок из MyWhoosh в Garmin Connect.

## Установка

1. Открой `chrome://extensions`.
2. Включи `Developer mode`.
3. Нажми `Load unpacked`.
4. Выбери папку: `C:\Users\rroko\PycharmProjects\mywhoosh-garmin-sync\browser-extension`.

## Использование

1. Нажми иконку расширения.
2. Нажми `Sync`.
3. Если MyWhoosh или Garmin не авторизованы, расширение само откроет вкладку входа.
4. Заверши логин в открытой вкладке. Sync продолжится автоматически.
5. `Copy Debug Logs` копирует лог последнего запуска.
6. `Clear Cache` очищает auth-кэш, processed-keys, статусы и логи.

## Что показывает popup

- `Processed` - сколько активностей уже прошло через текущий запуск
- `Uploaded` - сколько активностей загружено в Garmin
- `Duplicate` - сколько активностей Garmin уже знал
- `Failed` - сколько активностей не удалось обработать
