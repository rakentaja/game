# assets/source — raw upstream downloads (not committed)

`bun run assets` (or `bun scripts/fetch-assets.ts`) downloads every source listed in
`scripts/sources.ts` here and checks it against `assets/sources.lock.json` (sha256). Everything in
this folder except this README is gitignored: several upstream licences forbid redistributing the raw
packs, and they are reproducible.

| Flag | Effect |
|---|---|
| *(none)* | fetch what is missing, reuse `_cache/`, verify checksums |
| `--update` | accept new checksums after an upstream re-upload (re-check the licence first!) |
| `--force` | re-download everything |
| `<id> …` | only these source ids |

All sources are fetched without an account:

- **itch.io packs** (Quaternius UAL1/UAL2/UBC/Nature, KayKit Forest) use the public
  "Download Now → No thanks, just take me to the downloads" flow for the free ($0) tier.
- **KayKit Halloween Bits** comes from GitHub at a pinned commit; fonts from google/fonts at pinned commits.
- **ambientCG** direct download URL.
- **POC wizard** is decoded from `reference/poc/wizard-model.js` (already in the repo).

## Manual fallback

If a scripted download fails (rate limit, site change):

1. Open the source's `page` from `scripts/sources.ts` in a browser and download the same file
   (itch: the `[Standard]` / `Free` zip; ambientCG: `1K-JPG`).
2. Save it as `assets/source/_cache/<id>.bin` (the raw zip, renamed).
3. Re-run `bun scripts/fetch-assets.ts` — it verifies the checksum and extracts it.

Upstream for the POC wizard is the Google Drive folder linked from
<https://quaternius.com/packs/rpgcharacters.html> (often "quota exceeded"; that's why the repo copy is used).
