#!/usr/bin/env node
/**
 * E2E smoke test: drives the proxy (vite/wrangler dev) against the mock
 * registry, mimicking a Docker/containerd client's pull flow.
 *
 * Prereqs:
 *   1. cp .dev.vars.example .dev.vars        (PROXY_AUTH=off + e2e.test mirror group)
 *   2. npm run dev                           (http://127.0.0.1:8787)
 *   3. node scripts/mock-registry.mjs 5100 --seed --insecure-auth
 *
 * Usage: node scripts/e2e.mjs [proxyOrigin]
 */

import { createHash } from "node:crypto";

const PROXY = process.argv[2] ?? "http://127.0.0.1:8787";
const REGISTRY = "127.0.0.1:5100";

let failures = 0;
function check(name, ok, extra = "") {
	if (ok) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name} ${extra}`);
	}
}

const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");

const configBuf = Buffer.from(
	JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] } }),
);
const layerBuf = Buffer.from("e2e-test-layer-content");
const manifestBuf = Buffer.from(
	JSON.stringify({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		config: {
			mediaType: "application/vnd.oci.image.config.v1+json",
			digest: sha256(configBuf),
			size: configBuf.length,
		},
		layers: [
			{
				mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
				digest: sha256(layerBuf),
				size: layerBuf.length,
			},
		],
	}),
);
const manifestDigest = sha256(manifestBuf);

console.log("pull flow (path-prefix addressing):");

// 1. Ping (open mode)
let res = await fetch(`${PROXY}/${REGISTRY}/v2/`);
check("ping returns 200", res.status === 200, `got ${res.status}`);

// 2. Manifest by tag
res = await fetch(`${PROXY}/${REGISTRY}/v2/hello/manifests/v1`, {
	headers: { accept: "application/vnd.oci.image.manifest.v1+json" },
});
check("manifest by tag returns 200", res.status === 200, `got ${res.status}`);
const manifest = JSON.parse(await res.text());
check("manifest content matches seed", manifest.config?.digest === sha256(configBuf));
check(
	"docker-content-digest present",
	res.headers.get("docker-content-digest") === manifestDigest,
	res.headers.get("docker-content-digest") ?? "",
);

// 3. Manifest by digest (race path)
res = await fetch(`${PROXY}/${REGISTRY}/v2/hello/manifests/${manifestDigest}`, {
	headers: { accept: "application/vnd.oci.image.manifest.v1+json" },
});
check(
	"manifest by digest byte-exact",
	res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(manifestBuf),
	`status ${res.status}`,
);

// 4. Blobs (config + layer), byte-exact through the hedged path
for (const [label, buf] of [
	["config", configBuf],
	["layer", layerBuf],
]) {
	res = await fetch(`${PROXY}/${REGISTRY}/v2/hello/blobs/${sha256(buf)}`);
	const body = Buffer.from(await res.arrayBuffer());
	check(
		`blob ${label} round-trips byte-exact`,
		res.status === 200 && body.equals(buf),
		`status ${res.status}, ${body.length} bytes`,
	);
}

// 4b. Repeat blob pull is served from the edge cache (the mock never sets
// cache-control, so a rewritten max-age header proves a cache hit).
{
	res = await fetch(`${PROXY}/${REGISTRY}/v2/hello/blobs/${sha256(layerBuf)}`);
	const cached =
		(res.headers.get("cf-cache-status") ?? "").toUpperCase() === "HIT" ||
		/max-age=/.test(res.headers.get("cache-control") ?? "");
	check("repeat blob pull served from edge cache", res.status === 200 && cached, res.headers.get("cf-cache-status") ?? "");
}

// 5. Range request on a blob
{
	const digest = sha256(layerBuf);
	res = await fetch(`${PROXY}/${REGISTRY}/v2/hello/blobs/${digest}`, {
		headers: { range: "bytes=4-9" },
	});
	const body = await res.text();
	check("range request returns 206 + slice", res.status === 206 && body === layerBuf.toString().slice(4, 10), `status ${res.status} body=${body}`);
}

console.log("embedded addressing (/v2/{registry}/{repo}/...):");
res = await fetch(`${PROXY}/v2/${REGISTRY}/hello/manifests/v1`, {
	headers: { accept: "application/vnd.oci.image.manifest.v1+json" },
});
check(
	"embedded manifest pull byte-exact",
	res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(manifestBuf),
	`status ${res.status}`,
);

console.log("mirror-group fallback (e2e.test: dead member first):");
res = await fetch(`${PROXY}/e2e.test/v2/hello/manifests/v1`, {
	headers: { accept: "application/vnd.oci.image.manifest.v1+json" },
});
check(
	"tag served by the live mirror after the first member fails",
	res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(manifestBuf),
	`status ${res.status}`,
);

console.log("pull-only enforcement:");
res = await fetch(`${PROXY}/${REGISTRY}/v2/hello/blobs/uploads/`, { method: "POST" });
check("push (upload init) rejected with 405", res.status === 405, `got ${res.status}`);
res = await fetch(`${PROXY}/${REGISTRY}/v2/hello/manifests/v1`, {
	method: "PUT",
	headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
	body: manifestBuf,
});
check("push (manifest PUT) rejected with 405", res.status === 405, `got ${res.status}`);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
