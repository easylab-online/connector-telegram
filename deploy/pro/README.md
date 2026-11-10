# نشر connector-telegram — Docker (pro) + Ansible (mainServer)

مسار الإنتاج: صورة GHCR من فرع **`pro`**، وتشغيل على VPS عبر `infra/mainServer/services/unified-inbox-telegram/`.

## 1) بناء الصورة (CI)

`git push origin pro` → workflow [.github/workflows/publish-docker-pro.yml](../../.github/workflows/publish-docker-pro.yml) → `ghcr.io/easylab-online/connector-telegram:pro`.

بدون انتظار CI (مرة واحدة):

```bash
export GITHUB_TOKEN=…   # packages:write
./scripts/publish-docker-pro.sh
```

بناء محلي:

```bash
docker compose -f deploy/pro/compose.build.yml build
```

## 2) النشر على VPS (Ansible)

```bash
ansible-playbook -i mainServer/inventory.yml mainServer/200-deploy.yml
ansible-playbook -i mainServer/inventory.yml mainServer/services/unified-inbox-telegram/500-start.yml
```

**قبل أول تشغيل:** `500-start.yml` يشغّل `499-bootstrap-env.yml` تلقائياً إن لم يوجد `.env` ثم يسحب الصورة من GHCR. بديل بدون GHCR: `498-build-image-local.yml` ثم start مع `compose_service_pull: missing`. (يولّد `MASTER_KEY` و`WEBHOOK_SECRET` و`token`). عدّل على السيرفر `TDLIB_API_ID` / `TDLIB_API_HASH` و`TDLIB_DRIVER=tdjson` قبل الربط الحي. أو أنشئ `.env` يدوياً من [`.env.pro.example`](./.env.pro.example).

إيقاف:

```bash
ansible-playbook -i mainServer/inventory.yml mainServer/services/unified-inbox-telegram/501-stop.yml
```

## 3) Traefik والوصول

Compose الافتراضي: **`https://tg-inbox.easyfast.cloud`** (منفذ الحاوية 3095). غيّر الـ Host في `compose.yml` على VPS إن لزم.

`GET /health.json` بدون Bearer (مراقبة فقط).

## 4) أسرار Cloudflare Worker (unified-inbox-backend)

| Secret | يطابق |
|--------|--------|
| `TELEGRAM_USER_CONNECTOR_URL` | `https://tg-inbox.easyfast.cloud` |
| `TELEGRAM_USER_CONNECTOR_TOKEN` | `token` داخل `CLIENTS_JSON` |
| `TELEGRAM_USER_WEBHOOK_SECRET` | `WEBHOOK_SECRET` في `.env` الموصل |

أعد نشر backend على `pro` بعد ضبط الأسرار.

## 5) التحقق

```bash
curl -sS https://tg-inbox.easyfast.cloud/health.json
```

ثم من **Unified Inbox**: القنوات → تلجرام (حساب) → ربط QR أو OTP.

راجع `unified-inbox/backend/docs/evidence/telegram-user-vps-wiring.md` وقائمة القبول الحي.
