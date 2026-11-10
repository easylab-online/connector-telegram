# connector-telegram

مستودع **موصل تلجرام العادي** (حساب مستخدم — ليس Bot API).

- GitHub: https://github.com/easylab-online/connector-telegram
- موصل البوت المنفصل: [connector-telegram-bot](https://github.com/easylab-online/connector-telegram-bot)
- بوابة الصندوق: https://github.com/easylab-online/unified-inbox-backend

## الحالة

POC: خدمة Node + TDLib mock (`TDLIB_DRIVER=mock`)؛ API جلسات + webhook HMAC إلى البوابة. الإنتاج: صورة `deploy/pro` مع `TDLIB_DRIVER=tdjson` على VPS.

## تشغيل محلي

```bash
cp .env.example .env   # عدّل MASTER_KEY و WEBHOOK_* و CLIENTS_JSON
npm start
```

مواصفة البوابة: `unified-inbox/backend/specs/connectors/telegram-user.md` · قرار **D-TG-02**.
