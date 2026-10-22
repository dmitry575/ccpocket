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

## Что проверить после установки

```bash
systemctl status ccpocket-bridge --no-pager
journalctl -u ccpocket-bridge -n 50 --no-pager
ss -tlnp | grep -E ':8765|:8766'
```
