/** Room codes + invite links. 6 chars from an alphabet without look-alikes (no 0/O, 1/I/L). */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function generateRoomCode(rand: () => number = secureRandom): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

function secureRandom(): number {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0]! / 4294967296;
}

/** Normalize user input ("ab c-d2e" → "ABCD2E"); null if not a valid code. */
export function normalizeRoomCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return null;
  return s;
}

/** Invite URL for `code` based on the current page (keeps path/base, drops other params). */
export function inviteUrl(
  code: string,
  href: string = typeof location !== 'undefined' ? location.href : 'http://localhost/',
): string {
  const u = new URL(href);
  const keep = new URLSearchParams();
  // transport/netsim overrides travel with the invite so both ends agree (dev/e2e)
  for (const k of ['nettransport', 'netsim', 'lang']) {
    const v = u.searchParams.get(k);
    if (v) keep.set(k, v);
  }
  keep.set('room', code);
  u.search = keep.toString();
  u.hash = '';
  return u.toString();
}

/** `?room=CODE` from a URL/search string. */
export function roomFromUrl(
  search: string = typeof location !== 'undefined' ? location.search : '',
): string | null {
  return normalizeRoomCode(new URLSearchParams(search).get('room'));
}
