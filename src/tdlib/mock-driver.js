/** Mock TDLib for local POC without native bindings. */

const QR_TOKEN_PREFIX = 'tg-mock-qr:';

export function createMockTdlibDriver(options = {}) {
  const mockOtp = String(options.mockOtp ?? '00000');
  const sessions = new Map();
  const listeners = new Set();

  function emit(sessionId, type, data) {
    for (const fn of listeners) fn(sessionId, type, data);
  }

  function live(sessionId) {
    return sessions.get(sessionId) ?? { status: 'stopped' };
  }

  function ensure(sessionId) {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { status: 'stopped', qr: null, qrAt: 0, linkedPhone: null, linkedUserId: null });
    }
    return sessions.get(sessionId);
  }

  return {
    onUpdate(fn) {
      listeners.add(fn);
    },

    async startSession(sessionId) {
      const s = ensure(sessionId);
      if (s.status === 'open') return s;
      s.status = 'wait_phone';
      s.qr = `${QR_TOKEN_PREFIX}${sessionId}`;
      s.qrAt = Date.now();
      return s;
    },

    async stopSession(sessionId) {
      const s = ensure(sessionId);
      s.status = 'stopped';
      s.qr = null;
      return s;
    },

    getLive: live,

    async submitPhone(sessionId, phone) {
      const s = ensure(sessionId);
      if (!/^\+[1-9]\d{6,14}$/.test(String(phone ?? ''))) throw Object.assign(Error('invalid_phone'), { status: 400 });
      s.pendingPhone = phone;
      s.status = 'wait_code';
      s.qr = null;
      return s;
    },

    async submitCode(sessionId, code) {
      const s = ensure(sessionId);
      if (s.status !== 'wait_code' && s.status !== 'wait_qr') throw Object.assign(Error('not_waiting_code'), { status: 409 });
      if (String(code).trim() !== mockOtp) throw Object.assign(Error('invalid_code'), { status: 400 });
      await openSession(sessionId, s);
      return s;
    },

    async submitPassword(sessionId, password) {
      const s = ensure(sessionId);
      if (s.status !== 'wait_password') throw Object.assign(Error('not_waiting_password'), { status: 409 });
      if (!String(password ?? '').trim()) throw Object.assign(Error('invalid_password'), { status: 400 });
      await openSession(sessionId, s);
      return s;
    },

    async confirmQr(sessionId) {
      const s = ensure(sessionId);
      if (s.status !== 'wait_phone' && s.status !== 'wait_qr') throw Object.assign(Error('qr_not_available'), { status: 409 });
      s.status = 'wait_qr';
      await openSession(sessionId, s);
      return s;
    },

    async logout(sessionId) {
      sessions.delete(sessionId);
      emit(sessionId, 'connection.closed', { loggedOut: true });
    },

    async sendMessage(sessionId, { chatId, text }) {
      const s = ensure(sessionId);
      if (s.status !== 'open') throw Object.assign(Error('session_not_open'), { status: 409 });
      const messageId = String(Date.now());
      return { state: 'submitted', providerMessageId: messageId, chatId: String(chatId), text };
    },
  };

  async function openSession(sessionId, s) {
    s.status = 'open';
    s.linkedPhone = s.pendingPhone ?? '+96890000001';
    s.linkedUserId = 'mock-user-1';
    s.qr = null;
    emit(sessionId, 'connection.open', { linkedPhone: s.linkedPhone, linkedUserId: s.linkedUserId });
    const chatId = options.mockInboundChatId;
    const text = options.mockInboundText;
    if (chatId && text) {
      emit(sessionId, 'message.upsert', {
        chatId: String(chatId),
        messageId: `mock-${Date.now()}`,
        text,
        fromMe: false,
        senderName: 'Mock Contact',
      });
    }
  }
}

export function qrPayloadFromLive(live) {
  if (!live?.qr || Date.now() - (live.qrAt ?? 0) > 120000) return null;
  return live.qr;
}
