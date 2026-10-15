# Hosting the baked terrain (Cloudflare R2)

The game loads every terrain file relative to one manifest URL
(`DEFAULT_TERRAIN_URL`, `src/script/terrain/manifest.ts`). `assets/terrain` is
about 3 GB and ~38k files, far over GitHub Pages' ~1 GB limit, so the app goes on
Pages and the terrain on R2.

## One-time setup
1. R2 bucket, e.g. `retro-terrain`. Create an API token (Object Read & Write).
2. Attach a **custom domain** to the bucket (not `r2.dev`), so Cloudflare's cache
   sits in front. Cache hits are not billed as R2 reads.
3. Bucket CORS: allow `GET`, `HEAD` from your Pages origin (and
   `http://localhost:*` for testing), header `Range` if you add ranges later.
4. Cache Rule for the domain: match all, Eligible for cache, Edge TTL 1 month
   (respect origin also works, since objects carry `immutable`).
5. WAF rate-limiting rule for the domain, plus a usage notification in the
   dashboard. Optional: block requests whose `Referer` is not your site.

## Publish a bake
Pack the tree as Brotli first: 25-30 % smaller than the gzip the bake writes.
Quality 11 is slow (about 5 h for all of DACH), but later runs only re-pack
what a re-bake touched.
```bash
node tools/pack_terrain_br.mjs --out E:/retroflightsim-data/terrain-br
```
Then upload the packed tree. The uploader sees its `PACKED_BROTLI` marker and
sets `Content-Encoding: br` on the tiles (an unpacked tree goes up as gzip, as
before). The page cannot inflate Brotli itself, so the header must reach it;
R2 keeps it.
```bash
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
node tools/upload_terrain.mjs --bucket retro-terrain --version v1 \
     --src E:/retroflightsim-data/terrain-br \
     --endpoint https://<account>.r2.cloudflarestorage.com --dry-run
# drop --dry-run to upload
TERRAIN_URL=https://terrain.example.com/v1/manifest.json npm run build:prod
```
A production build with `TERRAIN_URL` set does not copy `assets/terrain` into
`dist/`. Re-baked terrain is a **new version** (`v2`), never an overwrite: objects
are `immutable` for a year, so overwriting would leave stale tiles in caches.

## Free-tier limits (check current values)
About 10 GB storage, 1M writes and 10M reads per month; egress is free. The
first upload is ~38k writes. Requests, not gigabytes, are what to watch.

## Verify
`curl -sI https://terrain.example.com/v1/12/1509/1203.ptm` should show
`content-encoding: br` (`gzip` for an unpacked tree), `cache-control: ... immutable`, and on the second
request `cf-cache-status: HIT`.
