# OCI Registry Proxy

A transparent OCI Distribution Spec v1 proxy on Cloudflare Workers. Pull and
push through one endpoint to any upstream registry — Docker Hub, ghcr.io,
quay.io, or your own.

## How clients address it

Docker, crane, containerd and friends treat the proxy host itself as a
registry, so the upstream appears as the first path segment (ECR
pull-through-cache convention):

```bash
docker pull proxy.example.com/library/nginx:latest          # Docker Hub (default)
docker pull proxy.example.com/ghcr.io/distribution/distribution:latest
docker pull proxy.example.com/quay.io/prometheus/prometheus:latest

docker login proxy.example.com
docker tag nginx proxy.example.com/ghcr.io/me/nginx && docker push proxy.example.com/ghcr.io/me/nginx
```

A path-prefix form is also served for tooling that speaks raw HTTP:

```bash
curl https://proxy.example.com/ghcr.io/v2/                  # ping
curl https://proxy.example.com/ghcr.io/v2/<repo>/manifests/latest
```

## What the proxy does

- **Transparent pass-through** — request/response bodies stream through
  (chunked PATCH uploads included); digests arrive byte-exact.
- **Auth relay** — upstream `WWW-Authenticate` realms are rewritten to
  `/token/{registry}`; the relay forwards credentials/scope to the real token
  endpoint (anonymous pulls work out of the box). Scopes computed from the
  proxied path (`repository:ghcr.io/owner/repo:pull`) are rewritten to the
  upstream's view (`repository:owner/repo:pull`).
- **Wildcard ping** — the bare `/v2/` ping challenges with a wildcard realm
  (`/token/-`) so clients don't lock onto the wrong registry's auth before the
  real registry is known from the resource path.
- **Upload Location rewriting** — same-host upload Locations point back
  through the proxy; with `REWRITE_ALL_LOCATIONS=true` cross-host Locations
  are relayed via `/-/up/{base64url}` instead of leaking upstream hosts.
- **GET/HEAD retry** — one retry on transient network failures.

## Configuration (`wrangler.json` vars)

| Var | Default | Purpose |
|---|---|---|
| `DEFAULT_REGISTRY` | `docker.io` | Upstream for bare `/v2/` routes and repo paths without a registry-looking first segment. Docker Hub repos get the `library/` namespace applied. |
| `ALLOWED_REGISTRIES` | `""` (all) | Comma-separated allowlist for `/{registry}/v2/...` and embedded addressing. |
| `REWRITE_ALL_LOCATIONS` | `false` | Relay every upstream Location through the proxy. |
| `INSECURE_REGISTRIES` | `""` | Comma-separated hosts contacted over plain http (localhost always is). |

Upstream credentials (server-side Basic auth used when the client sends none):

```bash
npx wrangler secret put REGISTRY_AUTHS   # {"ghcr.io": "user:pat", "registry.example.com:5000": "user:pass"}
```

`GET /api/status` reports the effective configuration.

## Platform notes

- Workers request-body limit is 100 MB (Free/Pro) / 200 MB (Business) per
  request; larger layers must be uploaded in chunks (docker/containerd do) or
  the plan limit raised.
- Blob CDN redirects (302) are followed server-side for GET/HEAD, so clients
  never see cross-host URLs.
- Client reference grammar forbids `:` in repository path segments, so
  embedded addressing can't name registries with ports; use the path-prefix
  routes for those.

## Development

```bash
npm install
npm run dev                       # vite dev server (React + worker)
node scripts/mock-registry.mjs 5100          # mock upstream (bearer auth)
npx wrangler dev --port 8787 &               # proxy (serves the built worker)
node scripts/e2e.mjs http://127.0.0.1:8787 localhost:5100
```

E2E covers pull (challenge → token → manifest → blobs → range), push
(POST → PATCH → PUT → manifest PUT, monolithic POST), both addressing forms,
and the status API.
