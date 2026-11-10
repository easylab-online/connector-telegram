import { createMockTdlibDriver } from './mock-driver.js';

/** Factory: mock (default) or tdjson when native TDLib is installed on VPS. */
export async function createTdlibDriver() {
  const mode = (process.env.TDLIB_DRIVER ?? 'mock').toLowerCase();
  if (mode === 'tdjson') {
    const apiId = process.env.TDLIB_API_ID;
    const apiHash = process.env.TDLIB_API_HASH;
    if (!apiId || !apiHash) throw Error('TDLIB_API_ID and TDLIB_API_HASH required for tdjson driver');
    const { createTdjsonDriver } = await import('./tdjson-driver.js');
    return createTdjsonDriver({ apiId: Number(apiId), apiHash: String(apiHash) });
  }
  return createMockTdlibDriver({
    mockOtp: process.env.MOCK_OTP,
    mockInboundChatId: process.env.MOCK_INBOUND_CHAT_ID,
    mockInboundText: process.env.MOCK_INBOUND_TEXT,
  });
}
