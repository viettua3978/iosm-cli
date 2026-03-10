import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["test/**/*.test.ts"],
		exclude: ["archive/**", "dist/**", "node_modules/**"],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
});
