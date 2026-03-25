# MyWhoosh -> Garmin

Расширение Chrome для синхронизации тренировок из MyWhoosh в Garmin Connect.

## Установка

1. Склонируй репозиторий или распакуй проект в любую папку на компьютере.
2. Открой `chrome://extensions`.
3. Включи `Developer mode`.
4. Нажми `Load unpacked`.
5. Выбери папку `browser-extension` из корня проекта.

Пример:
- если проект лежит в `C:\Projects\mywhoosh-garmin-sync`, то выбирать нужно `C:\Projects\mywhoosh-garmin-sync\browser-extension`
- выбирать корень репозитория не нужно, потому что `manifest.json` находится внутри `browser-extension`

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
