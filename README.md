# OCI Registry Aggregator

A pull-only OCI Distribution aggregator on Cloudflare Workers. One URL serves
every registry — Docker Hub, ghcr.io, quay.io, or your own — with mirror-group
fallback, digest racing, and edge caching. Push is not proxied.

The rule that shapes the design: content addressed by **digest** is identical
on every mirror, so those requests are raced; **tags** may lag on mirrors, so
those fall back through the group in order.

```bash
docker login proxy.example.com            # password = PROXY_TOKEN
docker pull proxy.example.com/library/nginx:latest
docker pull proxy.example.com/ghcr.io/distribution/distribution:latest
docker pull proxy.example.com/quay.io/prometheus/prometheus:latest
```

Both client addressing styles work:

- **Embedded** (docker/crane/containerd): the registry is the first path
  segment — `proxy.example.com/ghcr.io/owner/repo:latest`
- **Path prefix** (raw HTTP tooling): `proxy.example.com/ghcr.io/v2/owner/repo/manifests/latest`

## How pulls are served

| Request | Strategy |
|---|---|
| Manifest by **tag** | Members tried in order (canonical first); first success wins |
| Manifest by **digest** | All members race; first success wins, losers are cancelled |
| Blob (always digest) | Hedged: the leading member answers or the rest join after 150 ms |
| Tags list / referrers | Sequential fallback, never cached |

Members that fail (network error, 5xx, 429, auth broken) are penalized with
exponential backoff (30 s → 120 s) and skipped while unhealthy — per edge
location, with no external state. When every member is penalized, the group
is retried anyway so it can recover.

Responses are cached in Cloudflare's edge cache, keyed by **mirror group**
(not by the member that answered):

- Blobs and digest-addressed manifests: immutable, 30-day TTL
- Tag-addressed manifests: short TTL (default 120 s, `MANIFEST_TAG_TTL`)
- Range requests bypass the cache; nothing fetched with credentials is cached

## Authentication

The proxy is **fail-closed by default**:

| Config | Behavior |
|---|---|
| `PROXY_TOKEN` secret set | Clients `docker login` with any username and the token as password; the proxy exchanges it for a short-lived signed bearer (1 h) |
| nothing set | `/v2/*` answers 401 with setup instructions |
| `PROXY_AUTH=off` | Open proxy — local development only |

Upstream authentication is handled server-side: `REGISTRY_AUTHS` provides
per-member credentials (anonymous otherwise; in open mode the client's Basic
credentials are relayed). Clients never talk to upstream token endpoints.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DEFAULT_REGISTRY` | `docker.io` | Registry for bare `/v2/...` requests |
| `MIRROR_GROUPS` | *(empty)* | JSON: `{"docker.io": ["docker.io", "docker.m.daocloud.io"]}` — ordered members per registry |
| `ALLOWED_REGISTRIES` | *(empty)* | Comma-separated allowlist for client-chosen registries (the default registry is exempt) |
| `INSECURE_REGISTRIES` | *(empty)* | Hosts contacted over plain http (localhost always is) |
| `PROXY_AUTH` | *(empty)* | `off` disables proxy authentication |
| `MANIFEST_TAG_TTL` | `120` | Seconds a tag manifest may be served from cache |
| `BLOB_CACHE` | `true` | `false` disables the edge cache |

Secrets (`npx wrangler secret put ...`):

- `PROXY_TOKEN` — shared client token for `docker login`
- `REGISTRY_AUTHS` — JSON of per-member upstream credentials, e.g. `{"ghcr.io": "user:pat"}`

## Local development

```bash
cp .dev.vars.example .dev.vars   # open proxy + e2e mirror group
npm install
npm run dev                      # vite dev server on :8787

# terminal 2: seeded mock registry
node scripts/mock-registry.mjs 5100 --seed --insecure-auth

# terminal 3: smoke test (pull, cache, fallback, 405 on push)
node scripts/e2e.mjs
```

Quality gates:

```bash
npm test            # unit + integration tests (vitest)
npm run coverage    # coverage report (thresholds: 80% everywhere)
npm run lint
npm run check       # tsc + vite build + wrangler deploy --dry-run
```

## Architecture

```
src/worker/
  index.ts     Hono routes (thin)
  settings.ts  env → typed, memoized settings (mirror groups, auth mode, TTLs)
  registry.ts  upstream/group model, resource path parsing, docker library/ rule
  upstream.ts  upstream auth: challenge parsing, realm discovery, token cache
  strategy.ts  pull strategies (sequential / race / hedged) + member health
  auth.ts      proxy auth: shared-token exchange, HMAC-signed bearers
  caching.ts   edge-cache keys (group-namespaced) and TTL policy
  proxy.ts     handlers gluing it together (pull-only gate, auth gate, cache)
  util.ts      LRU map, base64url, constant-time compare, sha256
```

Limits worth knowing: the Workers Cache API is best-effort with a 512 MB
per-object cap (oversized layers stream uncached), and Docker Hub anonymous
rate limits apply from shared egress IPs — mirror groups and the edge cache
are the mitigation.
