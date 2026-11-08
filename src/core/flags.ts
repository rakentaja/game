/** URL debug flags: ?debug=1 ?autoplay=1 ?bench=1 ?page=1|2|3|boss ?seed=N ?lang=tr|en */
const q = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);

export const FLAGS = {
  debug: q.get('debug') === '1',
  autoplay: q.get('autoplay') === '1',
  bench: q.get('bench') === '1',
  page: q.get('page') as null | '1' | '2' | '3' | 'boss',
  seed: Number(q.get('seed') ?? 7),
  lang: q.get('lang') as null | 'tr' | 'en',
  /** Skip title/boot cinematic (e2e + dev). */
  skipIntro: q.get('skip') === '1' || q.get('autoplay') === '1',
};
