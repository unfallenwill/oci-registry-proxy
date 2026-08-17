import { Hono } from "hono";
import {
	registryProxy,
	statusHandler,
	tokenRelay,
	upstreamRelay,
	type WorkerEnv,
} from "./proxy";

const app = new Hono<{ Bindings: WorkerEnv }>();

// Proxy control plane
app.get("/api/status", statusHandler);

// Bearer token relay (target of rewritten WWW-Authenticate realms)
app.all("/token/:registry", tokenRelay);

// Absolute-URL relay for REWRITE_ALL_LOCATIONS deployments
app.all("/-/up/:url", upstreamRelay);

// OCI Distribution API, default registry (docker.io style)
app.all("/v2", registryProxy({ fromPath: false }));
app.all("/v2/*", registryProxy({ fromPath: false }));

// OCI Distribution API, explicit registry: /{registry}/v2/...
app.all("/:registry/v2", registryProxy({ fromPath: true }));
app.all("/:registry/v2/*", registryProxy({ fromPath: true }));

export default app;
