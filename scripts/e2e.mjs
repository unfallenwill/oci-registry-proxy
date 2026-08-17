#!/usr/bin/env node
/**
 * E2E test: drives the proxy at PROXY (wrangler dev) against the mock
 * registry, mimicking a Docker/containerd client's pull and push flows.
 *
 * Usage: node scripts/e2e.mjs [proxyOrigin] [registryKey]
 */

import { createHash } from "node:crypto";

const PROXY = process.argv[2] ?? "http://127.0.0.1:8787";
const REGISTRY = process.argv[3] ?? "localhost:5100";

let failures = 0;
function check(name, ok, extra = "") {
	if (ok) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name} ${extra}`);
	}
}

const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");

const makeManifest = (configBuf, layerBuf) =>
	Buffer.from(
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

// --- Seed the mock registry directly (as if the image was pushed before) ---
const configBuf = Buffer.from(
	JSON.stringify({ architecture: "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] } }),
);
const layerBuf = Buffer.from("e2e-test-layer-content");
const manifestBuf = makeManifest(configBuf, layerBuf);
const seedHeaders = { authorization: "Bearer seed", "content-type": "application/octet-stream" };
for (const [buf, kind, ref] of [
	[configBuf, "blob", sha256(configBuf)],
	[layerBuf, "blob", sha256(layerBuf)],
]) {
	const res = await fetch(`http://${REGISTRY}/v2/hello/blobs/uploads/?digest=${ref}`, {
		method: "POST",
		headers: seedHeaders,
		body: buf,
	});
	if (res.status !== 201) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
}
{
	const res = await fetch(`http://${REGISTRY}/v2/hello/manifests/v1`, {
		method: "PUT",
		headers: { authorization: "Bearer seed", "content-type": "application/vnd.oci.image.manifest.v1+json" },
		body: manifestBuf,
	});
	if (res.status !== 201) throw new Error(`seed manifest failed: ${res.status} ${await res.text()}`);
}
console.log(`seeded mock registry (manifest digest ${sha256(manifestBuf)})`);

const base = `${PROXY}/${REGISTRY}`;

// --- Pull flow, exactly like a docker client ---

console.log("pull flow:");

// 1. Ping /v2/ -> expect 401 with rewritten realm pointing at our /token relay
let res = await fetch(`${base}/v2/`);
check("ping returns 401", res.status === 401, `got ${res.status}`);
const challenge = res.headers.get("www-authenticate") ?? "";
check(
	"realm rewritten to proxy token relay",
	/realm="[^"]*\/token\/[^"]*"/.test(challenge),
	challenge,
);
check("service param preserved", /service="mock-registry"/.test(challenge), challenge);

// 2. Request a token from the relayed realm
const realmMatch = /realm="([^"]*)"/.exec(challenge);
const tokenUrl = new URL(`${realmMatch[1]}?service=mock-registry&scope=repository:hello:pull`);
res = await fetch(tokenUrl);
check("token relay returns 200", res.status === 200, `got ${res.status}`);
const tokenBody = await res.json();
check("token relay returns token", typeof tokenBody.token === "string", JSON.stringify(tokenBody));
check("token relay echoes scope", tokenBody.scope === "repository:hello:pull", tokenBody.scope);
const auth = { authorization: `Bearer ${tokenBody.token ?? "x"}` };

// 3. Fetch manifest by tag
res = await fetch(`${base}/v2/hello/manifests/v1`, {
	headers: { ...auth, accept: "application/vnd.oci.image.manifest.v1+json" },
});
check("manifest by tag returns 200", res.status === 200, `got ${res.status}`);
const manifest = JSON.parse(await res.text());
check("manifest content matches seed", manifest.config?.digest === sha256(configBuf));
const digestHeader = res.headers.get("docker-content-digest");
check("docker-content-digest present", digestHeader === sha256(manifestBuf), `${digestHeader}`);

// 4. Fetch blobs (config + layer)
for (const [label, buf] of [["config", configBuf], ["layer", layerBuf]]) {
	res = await fetch(`${base}/v2/hello/blobs/${sha256(buf)}`, { headers: auth });
	const body = Buffer.from(await res.arrayBuffer());
	check(
		`blob ${label} round-trips byte-exact`,
		res.status === 200 && body.equals(buf),
		`status ${res.status}, ${body.length} bytes`,
	);
}

// 5. Range request on a blob
{
	const digest = sha256(layerBuf);
	res = await fetch(`${base}/v2/hello/blobs/${digest}`, {
		headers: { ...auth, range: "bytes=4-9" },
	});
	const body = await res.text();
	check("range request returns 206 + slice", res.status === 206 && body === layerBuf.toString().slice(4, 10), `status ${res.status} body=${body}`);
}

// --- Push flow (chunked upload via POST/PATCH/PUT, then manifest PUT) ---

console.log("push flow:");

const newLayer = Buffer.from("pushed-layer-payload-" + Date.now());
const newConfig = Buffer.from(JSON.stringify({ architecture: "arm64", os: "linux", rootfs: { type: "layers", diff_ids: [] } }));
const newManifest = makeManifest(newConfig, newLayer);

// 1. Start upload session
res = await fetch(`${base}/v2/hello/blobs/uploads/`, { method: "POST", headers: auth });
check("upload init returns 202", res.status === 202, `got ${res.status}`);
let location = res.headers.get("location") ?? "";
check("upload location points back through proxy", location.startsWith(PROXY) || location.startsWith("/"), location);
const uploadUrl = new URL(location, PROXY);
res = await fetch(uploadUrl, {
	method: "PATCH",
	headers: { ...auth, "content-type": "application/octet-stream", "content-length": String(newLayer.length) },
	body: newLayer,
});
check("patch returns 202", res.status === 202, `got ${res.status}`);
location = res.headers.get("location") ?? "";
check("patch location points back through proxy", location.startsWith(PROXY) || location.startsWith("/"), location);
check("patch range header forwarded", /^0-\d+$/.test(res.headers.get("range") ?? ""), res.headers.get("range") ?? "");


// 3. PUT to finalize with digest
const finalize = new URL(location, PROXY);
finalize.searchParams.set("digest", sha256(newLayer));
res = await fetch(finalize, { method: "PUT", headers: auth });
check("finalize returns 201", res.status === 201, `got ${res.status}`);
check("finalize digest echoed", res.headers.get("docker-content-digest") === sha256(newLayer), res.headers.get("docker-content-digest"));

// --- Embedded-registry addressing: /v2/{registry}/{repo}/... (docker/crane form) ---

console.log("embedded-registry addressing (/v2/{registry}/{repo}/...):");

// Anonymous bare ping forwards to the default registry and rewrites its
// Bearer realm to the wildcard relay /token/-, so clients install a bearer
// transport without committing to the default registry's realm.
res = await fetch(`${PROXY}/v2/`);
check("bare anonymous ping returns 401", res.status === 401, `got ${res.status}`);
check(
	"ping realm is wildcard relay",
	/realm="[^"]*\/token\/-"/.test(res.headers.get("www-authenticate") ?? ""),
	res.headers.get("www-authenticate") ?? "",
);

{
	const tokenRes = await fetch(`${PROXY}/token/${REGISTRY}?service=mock-registry&scope=repository:hello:pull`);
	const tok = (await tokenRes.json()).token;
	check("token relay serves embedded registry", typeof tok === "string", JSON.stringify(tok));
	const embeddedAuth = { authorization: `Bearer ${tok}` };
	res = await fetch(`${PROXY}/v2/${REGISTRY}/hello/manifests/v1`, {
		headers: { ...embeddedAuth, accept: "application/vnd.oci.image.manifest.v1+json" },
	});
	const body = Buffer.from(await res.arrayBuffer());
	check(
		"embedded manifest pull byte-exact",
		res.status === 200 && body.equals(manifestBuf),
		`status ${res.status}`,
	);

	// Push through embedded addressing too
	res = await fetch(`${PROXY}/v2/${REGISTRY}/embedded/blobs/uploads/`, { method: "POST", headers: embeddedAuth });
	check("embedded upload init 202", res.status === 202, `got ${res.status}`);
	const loc = new URL(res.headers.get("location"), PROXY);
	check("embedded location keeps /v2/{registry} base", loc.pathname.startsWith(`/v2/${REGISTRY}/v2/`), loc.pathname);
	res = await fetch(loc, {
		method: "PATCH",
		headers: { ...embeddedAuth, "content-type": "application/octet-stream" },
		body: layerBuf,
	});
	check("embedded patch 202", res.status === 202, `got ${res.status}`);
	const fin = new URL(res.headers.get("location"), PROXY);
	fin.searchParams.set("digest", sha256(layerBuf));
	res = await fetch(fin, { method: "PUT", headers: embeddedAuth });
	check("embedded finalize 201", res.status === 201, `got ${res.status}`);
}

// 4. Config blob via single-POST monolithic upload
res = await fetch(`${base}/v2/hello/blobs/uploads/?digest=${sha256(newConfig)}`, {
	method: "POST",
	headers: { ...auth, "content-type": "application/octet-stream" },
	body: newConfig,
});
check("monolithic POST returns 201", res.status === 201, `got ${res.status}`);

// 5. PUT manifest
res = await fetch(`${base}/v2/hello/manifests/e2e`, {
	method: "PUT",
	headers: { ...auth, "content-type": "application/vnd.oci.image.manifest.v1+json" },
	body: newManifest,
});
check("manifest PUT returns 201", res.status === 201, `got ${res.status} ${await res.text()}`);

// 6. Pull the pushed image back through the proxy (manifest + layer)
res = await fetch(`${base}/v2/hello/manifests/e2e`, {
	headers: { ...auth, accept: "application/vnd.oci.image.manifest.v1+json" },
});
check("pushed manifest retrievable", res.status === 200, `got ${res.status}`);
res = await fetch(`${base}/v2/hello/blobs/${sha256(newLayer)}`, { headers: auth });
const roundTrip = Buffer.from(await res.arrayBuffer());
check("pushed layer round-trips byte-exact", res.status === 200 && roundTrip.equals(newLayer));

// --- Status API ---
console.log("control plane:");
res = await fetch(`${PROXY}/api/status`);
check("status api returns config", res.status === 200 && (await res.json()).service === "oci-registry-proxy");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
