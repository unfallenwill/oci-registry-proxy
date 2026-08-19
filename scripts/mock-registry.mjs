#!/usr/bin/env node
/**
 * Mock OCI registry for local E2E testing of the pull-only aggregator.
 * Implements the read side of the OCI Distribution API:
 *   GET/HEAD /v2/                       -> 401 Bearer (or 200 with --insecure-auth)
 *   GET      /token?<query>             -> token endpoint (echoes scope)
 *   GET/HEAD /v2/<name>/manifests/<ref> -> manifest
 *   GET/HEAD /v2/<name>/blobs/<digest>  -> blob (supports Range)
 *
 * `--seed` writes a fixture image (repo "hello", tag "v1") into the store
 * before serving, so tests do not need push support anywhere.
 *
 * Usage: node scripts/mock-registry.mjs <port> [--insecure-auth] [--seed]
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 5100);
const allowAnonymous = process.argv.includes("--insecure-auth");

const store = join(root, "..", ".tmp-registry-store");
const blobsDir = join(store, "blobs");
const manifestsDir = join(store, "manifests");

const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");

const blobPath = (digest) => join(blobsDir, digest.replace(":", "-"));

function seed() {
	mkdirSync(blobsDir, { recursive: true });
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
	writeFileSync(blobPath(sha256(configBuf)), configBuf);
	writeFileSync(blobPath(sha256(layerBuf)), layerBuf);
	const dir = join(manifestsDir, "hello");
	mkdirSync(dir, { recursive: true });
	for (const ref of ["v1", sha256(manifestBuf)]) {
		writeFileSync(join(dir, ref), manifestBuf);
		writeFileSync(`${join(dir, ref)}.ct`, "application/vnd.oci.image.manifest.v1+json");
	}
	console.log(`seeded hello:v1 (${sha256(manifestBuf).slice(7, 19)}…)`);
}

function send(res, status, headers, body) {
	res.writeHead(status, headers);
	if (body) res.write(body);
	res.end();
}

function json(res, status, obj, headers = {}) {
	send(res, status, { "content-type": "application/json", ...headers }, JSON.stringify(obj));
}

function unauthorized(req, res) {
	if (allowAnonymous) return false;
	if (/^Bearer /.test(req.headers.authorization ?? "")) return false;
	send(
		res,
		401,
		{
			"www-authenticate": `Bearer realm="http://localhost:${port}/token",service="mock-registry"`,
			"content-type": "application/json",
		},
		JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }),
	);
	return true;
}

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});
}

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${port}`);
	const path = url.pathname;

	if (path === "/token") {
		readBody(req).then(() => {
			json(res, 200, {
				token: "mock-token",
				access_token: "mock-token",
				expires_in: 300,
				scope: url.searchParams.get("scope") ?? "",
			});
		});
		return;
	}

	if (path === "/v2/" || path === "/v2") {
		if (unauthorized(req, res)) return;
		json(res, 200, {});
		return;
	}

	let m = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(path);
	if (m && (req.method === "GET" || req.method === "HEAD")) {
		if (unauthorized(req, res)) return;
		const [, name, ref] = m;
		const file = join(manifestsDir, name, ref);
		if (!existsSync(file)) {
			json(res, 404, { errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] });
			return;
		}
		const data = readFileSync(file);
		send(
			res,
			200,
			{
				"content-type": readFileSync(`${file}.ct`, "utf8").trim(),
				"docker-content-digest": sha256(data),
				"content-length": String(data.length),
			},
			req.method === "HEAD" ? undefined : data,
		);
		return;
	}

	m = /^\/v2\/(.+)\/blobs\/(sha256:[a-f0-9]{64})$/.exec(path);
	if (m && (req.method === "GET" || req.method === "HEAD")) {
		if (unauthorized(req, res)) return;
		const digest = m[2];
		const file = blobPath(digest);
		if (!existsSync(file)) {
			json(res, 404, { errors: [{ code: "BLOB_UNKNOWN", message: "blob unknown" }] });
			return;
		}
		const size = statSync(file).size;
		const headers = {
			"content-type": "application/octet-stream",
			"docker-content-digest": digest,
			"accept-ranges": "bytes",
			"content-length": String(size),
		};
		const range = req.headers.range;
		if (req.method === "GET" && range) {
			const rm = /bytes=(\d*)-(\d*)/.exec(range);
			const start = rm[1] === "" ? 0 : Number(rm[1]);
			const end = rm[2] === "" ? size - 1 : Number(rm[2]);
			res.writeHead(206, {
				...headers,
				"content-length": String(end - start + 1),
				"content-range": `bytes ${start}-${end}/${size}`,
			});
			createReadStream(file, { start, end }).pipe(res);
			return;
		}
		if (req.method === "GET") {
			res.writeHead(200, headers);
			createReadStream(file).pipe(res);
		} else {
			send(res, 200, headers);
		}
		return;
	}

	readBody(req).then(() => {
		json(res, 404, { errors: [{ code: "NOT_FOUND", message: `no route ${req.method} ${path}` }] });
	});
});

if (process.argv.includes("--seed")) seed();

server.listen(port, "127.0.0.1", () => {
	console.log(
		`mock registry listening on http://127.0.0.1:${port} (${allowAnonymous ? "anonymous" : "bearer"})`,
	);
});
