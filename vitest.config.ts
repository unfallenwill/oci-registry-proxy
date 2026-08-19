import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/worker/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/worker/**"],
			exclude: ["src/worker/**/*.test.ts", "src/worker/index.ts"],
			thresholds: {
				lines: 80,
				statements: 80,
				branches: 80,
				functions: 80,
			},
		},
	},
});
