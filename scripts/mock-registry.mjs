#!/usr/bin/env node
/**
 * Mock OCI registry for local E2E testing of the proxy.
 * Implements enough of the OCI Distribution API to exercise pull and push:
 *   GET/HEAD /v2/                       -> 401 Bearer (or 200 with --insecure-auth)
 *   GET      /token?<query>             -> token endpoint (echoes scope)
 *   GET/HEAD /v2/<name>/manifests/<ref> -> manifest
 *   GET/HEAD /v2/<name>/blobs/<digest>  -> blob (supports Range)
 *   POST     /v2/<name>/blobs/uploads/  -> 202 Location (or 201 for single-POST monolithic)
 *   PATCH/PUT /v2/<name>/blobs/uploads/<id>[?digest=] -> 202/201
 *   PUT      /v2/<name>/manifests/<ref> -> 201
 *
 * Usage: node scripts/mock-registry.mjs <port> [--insecure-auth]
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
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
mkdirSync(blobsDir, { recursive: true });
mkdirSync(manifestsDir, { recursive: true });

function blobPath(digest) {
	return join(blobsDir, digest.replace(":", "-"));
}

const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");

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

/** Consume the request body into memory, streaming each chunk to onChunk. */
function readBody(req, onChunk) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on("data", (c) => {
			chunks.push(c);
			onChunk?.(c);
		});
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

	if (m && req.method === "PUT") {
		if (unauthorized(req, res)) return;
		const [, name, ref] = m;
		readBody(req).then((data) => {
			const dir = join(manifestsDir, name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, ref), data);
			writeFileSync(
				`${join(dir, ref)}.ct`,
				req.headers["content-type"] ?? "application/vnd.oci.image.manifest.v1+json",
			);
			const digest = sha256(data);
			send(res, 201, {
				location: `/v2/${name}/manifests/${ref}`,
				"docker-content-digest": digest,
			});
		});
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

	m = /^\/v2\/(.+)\/blobs\/uploads\/$/.exec(path);
	if (m && req.method === "POST") {
		if (unauthorized(req, res)) return;
		const name = m[1];
		const digest = url.searchParams.get("digest");
		if (digest) {
			// Single-POST monolithic upload
			readBody(req).then((data) => {
				if (sha256(data) !== digest) {
					json(res, 400, { errors: [{ code: "DIGEST_INVALID", message: "digest mismatch" }] });
					return;
				}
				writeFileSync(blobPath(digest), data);
				send(res, 201, { location: `/v2/${name}/blobs/${digest}`, "docker-content-digest": digest });
			});
			return;
		}
		const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(join(store, id), Buffer.alloc(0));
		send(res, 202, {
			location: `/v2/${name}/blobs/uploads/${id}`,
			range: "0-0",
			"docker-upload-uuid": id,
		});
		return;
	}

	m = /^\/v2\/(.+)\/blobs\/uploads\/([^/]+)$/.exec(path);
	if (m && (req.method === "PATCH" || req.method === "PUT")) {
		if (unauthorized(req, res)) return;
		const [, name, id] = m;
		const file = join(store, id);
		const appending = existsSync(file);
		const existing = appending ? readFileSync(file) : null;
		const ws = createWriteStream(file, { flags: appending ? "a" : "w" });
		readBody(req, (c) => ws.write(c)).then((data) => {
			new Promise((resolve) => ws.end(resolve)).then(() => {
				const digest = sha256(existing ? Buffer.concat([existing, data]) : data);
				if (req.method === "PUT") {
					const want = url.searchParams.get("digest");
					if (want && want !== digest) {
						json(res, 400, { errors: [{ code: "DIGEST_INVALID", message: "digest mismatch" }] });
						return;
					}
					const final = want ?? digest;
					renameSync(file, blobPath(final));
					send(res, 201, {
						location: `/v2/${name}/blobs/${final}`,
						"docker-content-digest": final,
					});
				} else {
					send(res, 202, {
						location: `/v2/${name}/blobs/uploads/${id}`,
						range: `0-${statSync(file).size - 1}`,
						"docker-upload-uuid": id,
					});
				}
			});
		});
		return;
	}

	readBody(req).then(() => {
		json(res, 404, { errors: [{ code: "NOT_FOUND", message: `no route ${req.method} ${path}` }] });
	});
});

server.listen(port, "127.0.0.1", () => {
	console.log(
		`mock registry listening on http://127.0.0.1:${port} (${allowAnonymous ? "anonymous" : "bearer"})`,
	);
});
