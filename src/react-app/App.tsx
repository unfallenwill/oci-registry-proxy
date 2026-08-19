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

const GITHUB_URL = "https://github.com/unfallenwill/oci-registry-proxy";

// Docker reference grammar has no scheme; commands must show the bare host.
const registryHost = window.location.origin.replace(/^https?:\/\//, "");

/** One command line with a copy affordance — the whole point of this page. */
function Cmd({ children }: { children: string }) {
	const [copied, setCopied] = useState(false);
	const flash = () => {
		setCopied(true);
		setTimeout(() => setCopied(false), 1200);
	};
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(children);
			flash();
		} catch {
			// Clipboard API unavailable (insecure context): legacy fallback.
			const ta = document.createElement("textarea");
			ta.value = children;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			if (document.execCommand("copy")) flash();
			ta.remove();
		}
	};
	return (
		<div className="cmd">
			<code>{children}</code>
			<button className={`copy${copied ? " copied" : ""}`} onClick={copy}>
				{copied ? "copied" : "copy"}
			</button>
		</div>
	);
}

function Comment({ children }: { children: string }) {
	return <span className="comment"># {children}</span>;
}

/** Mirror group rendered as a chip chain: canonical first, then mirrors. */
function Chain({ name, members }: { name: string; members: string[] }) {
	return (
		<div className="chain">
			<span className="chain-name">{name}</span>
			<span className="arrow">:</span>
			{members.map((member, i) => (
				<span key={member} style={{ display: "contents" }}>
					{i > 0 && <span className="arrow">→</span>}
					<span className={`chip${i === 0 ? " canonical" : ""}`}>{member}</span>
				</span>
			))}
		</div>
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
			<header>
				<div>
					<h1>OCI Registry Aggregator</h1>
					<p className="tagline">
						Pull-only OCI Distribution aggregator on Cloudflare Workers: one URL, any
						registry — mirror fallback, digest racing, edge caching. Push is not proxied.
					</p>
				</div>
				<a className="gh" href={GITHUB_URL} aria-label="GitHub repository" title="GitHub">
					<svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
						<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
					</svg>
				</a>
			</header>

			<section>
				<h2>Pull</h2>
				<div className="term">
					{status?.authMode === "token" && (
						<>
							<Comment>Login once — any username, password is the proxy token</Comment>
							<Cmd>docker login {host}</Cmd>
						</>
					)}
					<Comment>Docker Hub (default registry, with its mirror group)</Comment>
					<Cmd>docker pull {host}/library/nginx:latest</Cmd>
					<Comment>Any registry, via embedded addressing or path prefix</Comment>
					<Cmd>docker pull {host}/ghcr.io/distribution/distribution:latest</Cmd>
					<Cmd>curl {host}/quay.io/v2/prom/prometheus/manifests/latest</Cmd>
				</div>
			</section>

			<section>
				<h2>Mirror groups</h2>
				{error && <p className="error">status unavailable: {error}</p>}
				{status &&
					(Object.keys(status.mirrorGroups).length === 0 ? (
						<p className="chain">
							No groups configured — each registry serves itself. Add <code>MIRROR_GROUPS</code>{" "}
							to introduce fallback mirrors.
						</p>
					) : (
						<div className="chains">
							{Object.entries(status.mirrorGroups).map(([name, members]) => (
								<Chain key={name} name={name} members={members} />
							))}
							<p className="chain-note">
								Tags fall back left → right; digest requests race every member.
							</p>
						</div>
					))}
			</section>

			{status && (
				<section>
					<h2>Configuration</h2>
					<table className="config">
						<tbody>
							<tr>
								<th>Mode</th>
								<td>
									<code>{status.mode}</code> — pull-only, edge-cached
								</td>
							</tr>
							<tr>
								<th>Authentication</th>
								<td>
									{status.authMode === "token" && "shared token (PROXY_TOKEN)"}
									{status.authMode === "off" && (
										<>
											disabled (<code>PROXY_AUTH=off</code>) — open proxy, anyone can pull
										</>
									)}
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
										? `blobs & digest manifests immutable · tag manifests ${status.manifestTagTtlSeconds}s`
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
				</section>
			)}
		</main>
	);
}

export default App;
