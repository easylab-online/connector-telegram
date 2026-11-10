import { randomBytes } from 'node:crypto';

/** UUIDv7 (time-ordered) for events and sessions. */
export function uuid7() {
  const buf = randomBytes(16);
  const ts = Date.now();
  buf[0] = (ts / 2 ** 40) & 0xff;
  buf[1] = (ts / 2 ** 32) & 0xff;
  buf[2] = (ts / 2 ** 24) & 0xff;
  buf[3] = (ts / 2 ** 16) & 0xff;
  buf[4] = (ts / 2 ** 8) & 0xff;
  buf[5] = ts & 0xff;
  buf[6] = (buf[6] & 0x0f) | 0x70;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
