import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { qrPayloadFromLive } from './mock-driver.js';

const require = createRequire(import.meta.url);
const tdl = require('tdl');
const { getTdjson } = require('prebuilt-tdlib');

let configured = false;
function ensureTdl() {
  if (configured) return;
  tdl.configure({ tdjson: getTdjson() });
  configured = true;
}

function mapAuthState(type) {
  if (type === 'authorizationStateWaitPhoneNumber') return 'wait_phone';
  if (type === 'authorizationStateWaitCode') return 'wait_code';
  if (type === 'authorizationStateWaitPassword') return 'wait_password';
  if (type === 'authorizationStateWaitOtherDeviceConfirmation') return 'wait_qr';
  if (type === 'authorizationStateReady') return 'open';
  if (type === 'authorizationStateClosed') return 'stopped';
  return null;
}

function messageText(content) {
  if (!content || typeof content !== 'object') return null;
  if (content._ === 'messageText' && content.text?.text) return String(content.text.text).trim();
  return null;
}

export function createTdjsonDriver({ apiId, apiHash, dataRoot = './data/tdlib' }) {
  ensureTdl();
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const sessions = new Map();
  const listeners = new Set();

  function emit(sessionId, type, data) {
    for (const fn of listeners) fn(sessionId, type, data);
  }

  function getSession(sessionId) {
    return sessions.get(sessionId);
  }

  function livePublic(s) {
    if (!s) return { status: 'stopped' };
    return {
      status: s.status,
      qr: qrPayloadFromLive(s),
      qrAt: s.qrAt,
      linkedPhone: s.linkedPhone,
      linkedUserId: s.linkedUserId,
    };
  }

  async function waitForPhone(s) {
    if (s.queuedPhone) {
      const phone = s.queuedPhone;
      s.queuedPhone = null;
      return phone;
    }
    return new Promise((resolve, reject) => {
      s._phoneResolve = resolve;
      s._phoneReject = reject;
    });
  }

  async function waitForCode(s) {
    if (s.queuedCode) {
      const code = s.queuedCode;
      s.queuedCode = null;
      return code;
    }
    return new Promise((resolve, reject) => {
      s._codeResolve = resolve;
      s._codeReject = reject;
    });
  }

  async function waitForPassword(s) {
    if (s.queuedPassword) {
      const pwd = s.queuedPassword;
      s.queuedPassword = null;
      return pwd;
    }
    return new Promise((resolve, reject) => {
      s._passwordResolve = resolve;
      s._passwordReject = reject;
    });
  }

  async function onReady(s) {
    try {
      const me = await s.client.invoke({ _: 'getMe' });
      const phone = typeof me?.phone_number === 'string' ? `+${me.phone_number.replace(/^\+/, '')}` : null;
      s.linkedPhone = phone;
      s.linkedUserId = me?.id != null ? String(me.id) : null;
      s.status = 'open';
      s.qr = null;
      emit(s.sessionId, 'connection.open', { linkedPhone: phone, linkedUserId: s.linkedUserId });
    } catch {
      s.status = 'open';
      emit(s.sessionId, 'connection.open', {});
    }
  }

  function attachUpdates(s) {
    s.client.on('update', update => {
      if (update._ === 'updateAuthorizationState') {
        const st = update.authorization_state;
        const mapped = mapAuthState(st._);
        if (mapped) s.status = mapped;
        if (st._ === 'authorizationStateWaitOtherDeviceConfirmation') {
          s.qr = typeof st.link === 'string' ? st.link : null;
          s.qrAt = Date.now();
        }
        if (st._ === 'authorizationStateReady') {
          void onReady(s);
        }
        if (st._ === 'authorizationStateClosed') {
          s.status = 'stopped';
          emit(s.sessionId, 'connection.closed', { loggedOut: false });
        }
      }
      if (update._ === 'updateNewMessage') {
        const msg = update.message;
        if (!msg || msg.is_outgoing) return;
        const text = messageText(msg.content);
        if (!text) return;
        const chatId = msg.chat_id != null ? String(msg.chat_id) : '';
        const messageId = msg.id != null ? String(msg.id) : '';
        if (!chatId || !messageId) return;
        emit(s.sessionId, 'message.upsert', {
          chatId,
          messageId,
          text,
          fromMe: false,
          senderName: typeof msg.sender_id?.user_id === 'number' ? undefined : undefined,
        });
      }
    });
  }

  async function startLogin(s) {
    try {
      await s.client.login({
        async getPhoneNumber(retry) {
          s.status = 'wait_phone';
          if (retry) throw Object.assign(Error('invalid_phone'), { status: 400 });
          const phone = await waitForPhone(s);
          if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw Object.assign(Error('invalid_phone'), { status: 400 });
          return phone;
        },
        async getAuthCode(retry) {
          s.status = 'wait_code';
          if (retry) throw Object.assign(Error('invalid_code'), { status: 400 });
          return await waitForCode(s);
        },
        async getPassword(_hint, retry) {
          s.status = 'wait_password';
          if (retry) throw Object.assign(Error('invalid_password'), { status: 400 });
          return await waitForPassword(s);
        },
      });
      if (s.status !== 'open') await onReady(s);
    } catch (e) {
      if (s.status !== 'stopped') s.status = 'stopped';
      throw e;
    }
  }

  return {
    onUpdate(fn) {
      listeners.add(fn);
    },

    getLive(sessionId) {
      return livePublic(getSession(sessionId));
    },

    async startSession(sessionId) {
      let s = getSession(sessionId);
      if (s?.status === 'open') return livePublic(s);
      if (s?.client) return livePublic(s);
      const dbDir = join(dataRoot, sessionId);
      mkdirSync(dbDir, { recursive: true, mode: 0o700 });
      const client = tdl.createClient({
        apiId,
        apiHash,
        databaseDirectory: dbDir,
        filesDirectory: join(dbDir, 'files'),
        useMessageDatabase: true,
      });
      s = {
        sessionId,
        client,
        status: 'stopped',
        qr: null,
        qrAt: 0,
        linkedPhone: null,
        linkedUserId: null,
        queuedPhone: null,
        queuedCode: null,
        queuedPassword: null,
      };
      sessions.set(sessionId, s);
      attachUpdates(s);
      void startLogin(s);
      s.status = 'wait_phone';
      return livePublic(s);
    },

    async stopSession(sessionId) {
      const s = getSession(sessionId);
      if (!s?.client) return livePublic(s);
      try {
        await s.client.close();
      } catch {}
      sessions.delete(sessionId);
      return { status: 'stopped' };
    },

    async submitPhone(sessionId, phone) {
      const s = getSession(sessionId);
      if (!s) throw Object.assign(Error('session_not_found'), { status: 404 });
      if (!/^\+[1-9]\d{6,14}$/.test(String(phone ?? ''))) throw Object.assign(Error('invalid_phone'), { status: 400 });
      if (s._phoneResolve) {
        s._phoneResolve(phone);
        s._phoneResolve = null;
      } else s.queuedPhone = phone;
      s.status = 'wait_code';
      return livePublic(s);
    },

    async submitCode(sessionId, code) {
      const s = getSession(sessionId);
      if (!s) throw Object.assign(Error('session_not_found'), { status: 404 });
      const c = String(code ?? '').trim();
      if (!c) throw Object.assign(Error('invalid_code'), { status: 400 });
      if (s._codeResolve) {
        s._codeResolve(c);
        s._codeResolve = null;
      } else s.queuedCode = c;
      return livePublic(s);
    },

    async submitPassword(sessionId, password) {
      const s = getSession(sessionId);
      if (!s) throw Object.assign(Error('session_not_found'), { status: 404 });
      const p = String(password ?? '');
      if (!p) throw Object.assign(Error('invalid_password'), { status: 400 });
      if (s._passwordResolve) {
        s._passwordResolve(p);
        s._passwordResolve = null;
      } else s.queuedPassword = p;
      return livePublic(s);
    },

    async confirmQr(sessionId) {
      const s = getSession(sessionId);
      if (!s?.client) throw Object.assign(Error('session_not_found'), { status: 404 });
      const deadline = Date.now() + 20000;
      while (
        !['wait_phone', 'wait_qr', 'stopped'].includes(s.status) &&
        s.status !== 'open' &&
        Date.now() < deadline
      ) {
        await new Promise(r => setTimeout(r, 150));
      }
      if (s.status === 'open') return livePublic(s);
      await s.client.invoke({ _: 'requestQrCodeAuthentication', other_user_ids: [] });
      s.status = 'wait_qr';
      const after = Date.now() + 15000;
      while (!s.qr && Date.now() < after) {
        await new Promise(r => setTimeout(r, 150));
      }
      return livePublic(s);
    },

    async logout(sessionId) {
      const s = getSession(sessionId);
      if (!s?.client) {
        sessions.delete(sessionId);
        return;
      }
      try {
        await s.client.invoke({ _: 'logOut' });
        await s.client.close();
      } catch {}
      sessions.delete(sessionId);
      emit(sessionId, 'connection.closed', { loggedOut: true });
    },

    async sendMessage(sessionId, { chatId, text }) {
      const s = getSession(sessionId);
      if (!s?.client || s.status !== 'open') throw Object.assign(Error('session_not_open'), { status: 409 });
      const chat_id = Number(chatId);
      if (!Number.isFinite(chat_id)) throw Object.assign(Error('invalid_chat_id'), { status: 400 });
      const result = await s.client.invoke({
        _: 'sendMessage',
        chat_id,
        input_message_content: {
          _: 'inputMessageText',
          text: { _: 'formattedText', text: String(text) },
        },
      });
      const messageId = result?.id != null ? String(result.id) : String(Date.now());
      return { state: 'submitted', providerMessageId: messageId, chatId: String(chatId), text };
    },
  };
}
