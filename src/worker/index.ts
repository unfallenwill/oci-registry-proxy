import { Hono } from "hono";
import { authEndpoint, registryProxy, statusHandler, type WorkerEnv } from "./proxy";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.get("/api/status", statusHandler);
/** Token endpoint behind our own auth challenge (docker login lands here). */
app.all("/-/auth", authEndpoint);
app.all("/v2", registryProxy({ fromPath: false }));
app.all("/v2/*", registryProxy({ fromPath: false }));
app.all("/:registry/v2", registryProxy({ fromPath: true }));
app.all("/:registry/v2/*", registryProxy({ fromPath: true }));

export default app;
