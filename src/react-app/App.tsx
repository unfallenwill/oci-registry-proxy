import { useEffect, useState } from "react";
import "./App.css";

interface Status {
	service: string;
	defaultRegistry: string;
	allowedRegistries: string[];
	rewriteAllLocations: boolean;
	upstreamCredentialsConfigured: boolean;
	insecureRegistries: string[];
	blobCache: boolean;
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

	return (
		<main className="page">
			<h1>OCI Registry Proxy</h1>
			<p className="tagline">
				Transparent OCI Distribution (pull &amp; push) proxy on Cloudflare Workers.
			</p>

			<section>
				<h2>Pull</h2>
				<pre>
					<Code>{`# Docker Hub (default registry)`}</Code>
					<Code>{`docker pull ${registryHost || "<proxy-host>"}/library/nginx:latest`}</Code>
					<Code>{`# Any registry, via path prefix`}</Code>
					<Code>{`docker pull ${registryHost || "<proxy-host>"}/ghcr.io/distribution/distribution:latest`}</Code>
				</pre>
			</section>

			<section>
				<h2>Push</h2>
				<pre>
					<Code>{`docker login ${registryHost || "<proxy-host>"}   # upstream credentials`}</Code>
					<Code>{`docker tag nginx:latest ${registryHost || "<proxy-host>"}/username/nginx:latest`}</Code>
					<Code>{`docker push ${registryHost || "<proxy-host>"}/username/nginx:latest`}</Code>
				</pre>
			</section>

			<section>
				<h2>Configuration</h2>
				{error && <p className="error">status unavailable: {error}</p>}
				{status && (
					<table className="config">
						<tbody>
							<tr>
								<th>Default registry</th>
								<td>
									<code>{status.defaultRegistry}</code> (bare <code>/v2/</code> routes)
								</td>
							</tr>
							<tr>
								<th>Registry allowlist</th>
								<td>
									{status.allowedRegistries.length === 0
										? "all registries allowed via /{registry}/v2/..."
										: status.allowedRegistries.join(", ")}
								</td>
							</tr>
							<tr>
								<th>Location rewriting</th>
								<td>{status.rewriteAllLocations ? "all through proxy" : "same-host only"}</td>
							</tr>
							<tr>
								<th>Upstream credentials</th>
								<td>{status.upstreamCredentialsConfigured ? "configured (REGISTRY_AUTHS)" : "client credentials only"}</td>
							</tr>
							<tr>
								<th>Blob edge cache</th>
								<td>{status.blobCache ? "enabled (public registries)" : "disabled"}</td>
							</tr>
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
