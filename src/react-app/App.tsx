import { useEffect, useState } from "react";
import "./App.css";

interface Status {
	service: string;
	mode: string;
	defaultRegistry: string;
	mirrorGroups: Record<string, string[]>;
	allowedRegistries: string[];
	insecureRegistries: string[];
	authMode: "token" | "off" | "unconfigured";
	edgeCache: boolean;
	manifestTagTtlSeconds: number;
	upstreamCredentialsConfigured: string[];
}

// Docker reference grammar has no scheme; commands must show the bare host.
const registryHost = window.location.origin.replace(/^https?:\/\//, "");

function Code({ children }: { children: string }) {
	return (
		<code className="snippet">
			{children}
			<br />
		</code>
	);
}

function App() {
	
	const [status, setStatus] = useState<Status | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		fetch("/api/status")
			.then((res) => res.json() as Promise<Status>)
			.then(setStatus)
			.catch((e) => setError(String(e)));
	}, []);

	const host = registryHost || "<proxy-host>";

	return (
		<main className="page">
			<h1>OCI Registry Aggregator</h1>
			<p className="tagline">
				Pull-only OCI Distribution aggregator on Cloudflare Workers: one URL, any registry,
				mirror fallback, digest racing, and edge caching. Push is not proxied.
			</p>

			<section>
				<h2>Pull</h2>
				<pre>
					<Code>{`# Login once (password = PROXY_TOKEN)`}</Code>
					<Code>{`docker login ${host}`}</Code>
					<Code>{`# Docker Hub (default registry, with its mirror group)`}</Code>
					<Code>{`docker pull ${host}/library/nginx:latest`}</Code>
					<Code>{`# Any registry, via path prefix or embedded addressing`}</Code>
					<Code>{`docker pull ${host}/ghcr.io/distribution/distribution:latest`}</Code>
				</pre>
			</section>

			<section>
				<h2>Configuration</h2>
				{error && <p className="error">status unavailable: {error}</p>}
				{status && (
					<table className="config">
						<tbody>
							<tr>
								<th>Mode</th>
								<td>
									<code>{status.mode}</code> — tag lookups fall back through mirror groups,
									digest lookups race every member
								</td>
							</tr>
							<tr>
								<th>Authentication</th>
								<td>
									{status.authMode === "token" && "shared token (PROXY_TOKEN)"}
									{status.authMode === "off" && "disabled (PROXY_AUTH=off)"}
									{status.authMode === "unconfigured" && (
										<span className="error">
											not configured — set PROXY_TOKEN or disable with PROXY_AUTH=off
										</span>
									)}
								</td>
							</tr>
							<tr>
								<th>Default registry</th>
								<td>
									<code>{status.defaultRegistry}</code> (bare <code>/v2/</code> routes)
								</td>
							</tr>
							<tr>
								<th>Mirror groups</th>
								<td>
									{Object.keys(status.mirrorGroups).length === 0
										? "none configured (each registry is its own group)"
										: Object.entries(status.mirrorGroups).map(([name, members]) => (
												<div key={name}>
													<code>{name}</code> → {members.join(" → ")}
												</div>
											))}
								</td>
							</tr>
							<tr>
								<th>Registry allowlist</th>
								<td>
									{status.allowedRegistries.length === 0
										? "all registries allowed"
										: status.allowedRegistries.join(", ")}
								</td>
							</tr>
							<tr>
								<th>Edge cache</th>
								<td>
									{status.edgeCache
										? `enabled (blobs & digest manifests immutable, tag manifests ${status.manifestTagTtlSeconds}s)`
										: "disabled"}
								</td>
							</tr>
							{status.upstreamCredentialsConfigured.length > 0 && (
								<tr>
									<th>Upstream credentials</th>
									<td>{status.upstreamCredentialsConfigured.join(", ")} (never cached)</td>
								</tr>
							)}
							{status.insecureRegistries.length > 0 && (
								<tr>
									<th>Insecure (http) registries</th>
									<td>{status.insecureRegistries.join(", ")}</td>
								</tr>
							)}
						</tbody>
					</table>
				)}
			</section>
		</main>
	);
}

export default App;
