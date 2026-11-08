/**
 * Minimal itch.io "name your own price" downloader for free files (the same flow as clicking
 * "Download Now" → "No thanks, just take me to the downloads"). No login, no payment.
 */

type Cookie = Map<string, string>;

function cookieHeader(c: Cookie): string {
  return [...c].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorb(c: Cookie, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const kv = line.split(';')[0] ?? '';
    const i = kv.indexOf('=');
    if (i > 0) c.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

/** itch.io rate-limits bursts (429); back off and retry. */
async function req(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= 5) return res;
    await Bun.sleep(5000 * 2 ** attempt);
  }
}

async function get(url: string, c: Cookie): Promise<string> {
  const res = await req(url, { headers: { cookie: cookieHeader(c), 'user-agent': UA } });
  absorb(c, res);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function post(url: string, c: Cookie, form: Record<string, string>): Promise<unknown> {
  const res = await req(url, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(c),
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams(form).toString(),
  });
  absorb(c, res);
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json();
}

const UA = 'inkwake-asset-fetch/1.0';

function csrf(html: string): string {
  const m = html.match(/name="csrf_token" value="([^"]+)"/);
  if (!m) throw new Error('itch: csrf token not found');
  return m[1]!;
}

export interface ItchUpload {
  id: string;
  name: string;
}

/** Resolve the free uploads of a pack page, e.g. ('quaternius', 'universal-animation-library'). */
export async function itchUploads(
  user: string,
  slug: string,
): Promise<{ uploads: ItchUpload[]; resolve: (u: ItchUpload) => Promise<string> }> {
  const c: Cookie = new Map();
  const base = `https://${user}.itch.io/${slug}`;
  const page = await get(base, c);
  const token = csrf(page);
  const { url } = (await post(`${base}/download_url`, c, { csrf_token: token })) as { url: string };
  const dl = await get(url, c);
  const dlToken = csrf(dl);
  const uploads: ItchUpload[] = [];
  // attribute order varies between pages: match the first <strong … title="…"> after the id
  const re = /data-upload_id="(\d+)"[\s\S]*?<strong[^>]*\btitle="([^"]+)"/g;
  for (let m = re.exec(dl); m; m = re.exec(dl)) uploads.push({ id: m[1]!, name: m[2]! });
  if (!uploads.length) {
    if (process.env.ITCH_DEBUG) await Bun.write(process.env.ITCH_DEBUG, dl);
    throw new Error(`itch: no free uploads found on ${base}`);
  }
  const resolve = async (u: ItchUpload): Promise<string> => {
    const r = (await post(`${base}/file/${u.id}?source=game_download`, c, { csrf_token: dlToken })) as {
      url?: string;
    };
    if (!r.url) throw new Error(`itch: no url for ${u.name}`);
    return r.url;
  };
  return { uploads, resolve };
}
