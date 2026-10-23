# Развёртывание моста на сервере (форк dmitry575/ccpocket)

Схема: приложение CC Pocket → `wss://<IP>:8766` (nginx, сертификат Let's Encrypt на IP) → `ws://127.0.0.1:8765` (мост) → Claude Agent SDK → `claude` с уже выполненным входом по подписке.

## Установка одной командой

```bash
bash /root/ccpocket/deploy/install.sh
```

Скрипт:

1. копирует конфиг nginx `nginx-ccpocket-bridge.conf` в `sites-available` и включает его (порт 8766, TLS);
2. создаёт `/etc/ccpocket-bridge.env` с новым случайным ключом доступа (если файла ещё нет);
3. ставит системную службу `ccpocket-bridge` (`ccpocket-bridge.service`), включает и запускает её;
4. ставит пару `ccpocket-nginx-reload.path` + `.service`: при продлении сертификата `/root/cert/ip/fullchain.pem` nginx перезагружается сам;
5. печатает ссылку подключения для приложения.

## Подключение приложения

В CC Pocket (App Store / Google Play) выбрать подключение по адресу и ввести ссылку вида:

```
адрес: wss://167.104.102.253:8766
ключ (token): значение BRIDGE_API_KEY из /etc/ccpocket-bridge.env
или одной ссылкой: ccpocket://connect?url=wss%3A%2F%2F167.104.102.253%3A8766&token=<ключ>
```

Либо показать QR-код из журнала службы: `journalctl -u ccpocket-bridge -n 80`.

## Обновление моста из форка

Рабочая ветка форка: `worktree-windows-installer` (в ней развёртывание, исправления после аудита и установщик Windows).

```bash
cd /root/ccpocket && git fetch origin && git checkout worktree-windows-installer && git pull --ff-only \
  && npm install --ignore-scripts --no-audit --no-fund && npm run bridge:build \
  && bash deploy/install.sh
```

### Перезапуск без потери работы

Сессии Claude работают дочерними процессами моста, поэтому `systemctl restart ccpocket-bridge` обрывает все идущие ходы и фоновых субагентов, и продолжить их уже нельзя. Для обычных обновлений перезапускайте так:

```bash
bash deploy/restart-when-idle.sh                 # ждёт, пока ни одна сессия не занята
bash deploy/restart-when-idle.sh --max-wait 1800 # не дольше 30 минут, иначе выходит без перезапуска
```

Скрипт берёт ключ из `/etc/ccpocket-bridge.env` и опрашивает `/health`: поле `busy` перечисляет сессии с идущим ходом, ожидающим разрешением или фоновыми задачами (субагенты, фоновые команды). Перезапуск происходит, когда список пуст две проверки подряд. Мост без этого поля (сборка старше 23.10.2026) скрипт не перезапускает без `--force`.

`install.sh` не трогает существующий `/etc/ccpocket-bridge.env`. Новые переменные (`BRIDGE_MAX_IDLE_SESSIONS=3`, `BRIDGE_MAX_LIVE_SESSIONS=5`) допишите в него руками, если файл создан раньше.

После выкладки версии с авторизацией HTTP-маршрутов галерею в nginx можно открыть обратно (убрать строку `location /api/gallery { return 403; }` в `/etc/nginx/sites-available/ccpocket-bridge`): мост сам требует ключ. `/usage` и `/doctor` лучше оставить закрытыми, клиент ими не пользуется.

## Переменные окружения

| Переменная | Значение | Зачем |
|---|---|---|
| `BRIDGE_HOST` | `127.0.0.1` | наружу смотрит только nginx |
| `BRIDGE_PORT` | `8765` | порт моста на петле |
| `BRIDGE_API_KEY` | случайный | ключ доступа приложения |
| `BRIDGE_PUBLIC_WS_URL` | `wss://167.104.102.253:8766` | адрес в QR и ссылке |
| `BRIDGE_ALLOW_CLAUDE_OAUTH` | `1` | разрешить вход по подписке |
| `BRIDGE_ALLOWED_DIRS` | `/root` | каталоги проектов |
| `BRIDGE_IDLE_SESSION_TTL_MINUTES` | `30` | гасить простаивающие сессии (каждая держит процесс claude ≈300 МБ) |
| `BRIDGE_MAX_IDLE_SESSIONS` | `3` | не держать больше стольких простаивающих процессов (в upstream 30) |
| `BRIDGE_MAX_LIVE_SESSIONS` | `5` | жёсткий предел живых процессов агентов: сначала вытесняются простаивающие, потом отказ `session_limit_reached` |
| `BRIDGE_DISABLE_MDNS` | `1` | на сервере mDNS не нужен |

## Токены устройств (вместо одного общего ключа)

Мост принимает и общий `BRIDGE_API_KEY`, и именные токены устройств. Токены хранятся хешами в `/root/.ccpocket/devices.json` (права 600), мост перечитывает файл при изменении, перезапуск не нужен.

```bash
cd /root/ccpocket/packages/bridge
BRIDGE_PUBLIC_WS_URL=wss://167.104.102.253:8766 node dist/cli.js devices add "Телефон"   # печатает токен, ссылку и QR
node dist/cli.js devices list
node dist/cli.js devices rotate <id>   # новый токен для того же устройства
node dist/cli.js devices revoke <id>   # токен перестаёт работать сразу
```

В приложении устройство подключается своим токеном (адрес тот же, ключ = токен). Общий ключ можно оставить как запасной или убрать из `/etc/ccpocket-bridge.env`, когда у всех устройств есть свои токены.

## Прочие настройки форка

| Переменная | Значение по умолчанию | Зачем |
|---|---|---|
| `BRIDGE_PERMISSION_TIMEOUT_MINUTES` | `60` | неотвеченный запрос разрешения отклоняется сам, процесс освобождается; `0` отключает |
| `BRIDGE_FIREBASE_API_KEY` | ключ проекта автора | свой проект Firebase для push |
| `BRIDGE_PUSH_RELAY_URL` | функция автора | адрес своей облачной функции `relay` (папка `functions`) |

Возобновление сессии, которую уже держит `claude --bg` или терминал, запущенный с `--resume <id>`, мост отклоняет с кодом `session_held_externally`; в приложении включите «Fork session on resume», чтобы продолжить в копии.

## Релизы форка

- Только Windows: тег `windows-setup/v<версия>+<сборка>` → workflow `windows-installer.yml` (установщик + zip).
- Все платформы разом: тег `release/v<версия>+<сборка>` → workflow `all-platforms-release.yml`: Windows (установщик + zip), macOS (dmg, подпись ad-hoc без нотаризации), Linux (tar.gz), Android (apk). iOS не собирается: нужен аккаунт разработчика Apple.
- Подпись Android: ключ в `/root/ccpocket-secrets/`, загрузка в секреты репозитория `bash deploy/set-android-secrets.sh` (один раз). Без секретов apk подписывается отладочным ключом.

Пример выпуска: `git tag -a release/v1.145.4+278 -m "..." && git push origin release/v1.145.4+278`.

## Что проверить после установки

```bash
systemctl status ccpocket-bridge --no-pager
journalctl -u ccpocket-bridge -n 50 --no-pager
ss -tlnp | grep -E ':8765|:8766'
```
