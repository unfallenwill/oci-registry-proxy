import { Hono } from "hono";
import {
	registryProxy,
	statusHandler,
	tokenRelay,
	upstreamRelay,
	type WorkerEnv,
} from "./proxy";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.get("/api/status", statusHandler);
app.all("/token/:registry", tokenRelay);
app.all("/-/up/:url", upstreamRelay);
app.all("/v2", registryProxy({ fromPath: false }));
app.all("/v2/*", registryProxy({ fromPath: false }));
app.all("/:registry/v2", registryProxy({ fromPath: true }));
app.all("/:registry/v2/*", registryProxy({ fromPath: true }));

export default app;
