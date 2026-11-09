/**
 * Co-op networking configuration. See docs/COOP.md.
 *
 * Nothing secret lives in this file. TURN and Firebase credentials are injected at BUILD time via
 * Vite env vars (e.g. a git-ignored `.env.local` or CI secrets):
 *
 *   VITE_TURN_URLS        comma-separated, e.g. "turns:global.relay.metered.ca:443?transport=tcp,turn:global.relay.metered.ca:80"
 *   VITE_TURN_USERNAME    static username from Metered Open Relay / ExpressTURN dashboard
 *   VITE_TURN_CREDENTIAL  static credential
 *   VITE_FIREBASE_DB_URL  e.g. "https://my-project-default-rtdb.europe-west1.firebasedatabase.app"
 *   VITE_FIREBASE_API_KEY web API key (enables anonymous auth so security rules can require auth)
 *   VITE_NOSTR_RELAYS     optional comma-separated wss:// relay override
 *   VITE_MQTT_RELAYS      optional comma-separated wss:// MQTT broker override
 *
 * NOTE: anything baked into a static web build is readable by anyone who opens devtools. Use TURN
 * credentials that are free/low-value and rate-limited (that is what Open Relay's static creds
 * are), and never a paid account's master key.
 */

export interface TurnServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface FirebaseConfig {
  /** Realtime Database root URL (no trailing slash). */
  dbUrl: string;
  /** Web API key; when set, the relay signs in anonymously and passes `?auth=<idToken>`. */
  apiKey?: string;
}

export interface NetConfig {
  /** Trystero app id (namespaces our rooms on public signaling relays). */
  appId: string;
  /** Tier 1 signaling: Nostr relays (account-free). Empty → Trystero's built-in defaults. */
  nostrRelays: string[];
  /** Nostr relays used per room (Trystero redundancy). */
  nostrRedundancy: number;
  /** Fallback signaling: public MQTT-over-WebSocket brokers. */
  mqttRelays: string[];
  stun: string[];
  /**
   * Tier 2: TURN with STATIC credentials. Ships EMPTY on purpose — supply via VITE_TURN_* at
   * build time (see docs/COOP.md "Getting free TURN credentials"). Prefer `turns:` on 443.
   */
  turn: TurnServer[];
  /** Tier 3: Firebase Realtime Database relay; null = disabled. */
  firebase: FirebaseConfig | null;
  /** ICE must reach `connected` within this after a peer connection appears, else step tier. */
  iceTimeoutMs: number;
  /** Guest: no peer via Nostr within this → also try MQTT signaling. */
  signalFallbackMs: number;
  /** Give up connecting entirely (UI shows "failed") after this. */
  connectTimeoutMs: number;
  /** Firebase relay batch rate (Hz). */
  relayHz: number;
  /** Seconds a dropped player's slot is kept for rejoin. */
  rejoinWindowS: number;
  /** Lobby ping interval for RTT / clock sync (ms). */
  pingMs: number;
}

const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function turnFromEnv(): TurnServer[] {
  const urls = list(env.VITE_TURN_URLS);
  if (!urls.length) return [];
  // TLS-on-443 first: it survives the most restrictive firewalls/captive proxies
  urls.sort((a, b) => Number(!/^turns:.*:443/.test(a)) - Number(!/^turns:.*:443/.test(b)));
  return [{ urls, username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL }];
}

function firebaseFromEnv(): FirebaseConfig | null {
  const dbUrl = env.VITE_FIREBASE_DB_URL?.trim().replace(/\/+$/, '');
  if (!dbUrl) return null;
  return { dbUrl, apiKey: env.VITE_FIREBASE_API_KEY?.trim() || undefined };
}

export const NET_CONFIG: NetConfig = {
  appId: 'inkwake-coop-v1',
  nostrRelays: list(env.VITE_NOSTR_RELAYS).length
    ? list(env.VITE_NOSTR_RELAYS)
    : [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band',
        'wss://relay.snort.social',
        'wss://nostr.mom',
        'wss://relay.primal.net',
      ],
  nostrRedundancy: 4,
  mqttRelays: list(env.VITE_MQTT_RELAYS).length
    ? list(env.VITE_MQTT_RELAYS)
    : [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt',
        'wss://test.mosquitto.org:8081/mqtt',
      ],
  stun: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  turn: turnFromEnv(),
  firebase: firebaseFromEnv(),
  iceTimeoutMs: 4000,
  signalFallbackMs: 8000,
  connectTimeoutMs: 30_000,
  relayHz: 12,
  rejoinWindowS: 60,
  pingMs: 1000,
};
