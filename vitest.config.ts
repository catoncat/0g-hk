// Vitest config (v4 API).
// `cloudflareTest` is a Vite plugin that registers the workers runner; bindings
// (NOTES kv, AI, ASSETS) come from the production wrangler.toml so tests see
// the same environment as the deployed worker. KV is mocked, AI fails open.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Don't try to talk to the real Cloudflare API for `remote: true`
      // bindings; everything (KV, AI, ASSETS) runs in miniflare locally.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: { compatibilityDate: "2024-12-01" },
    }),
  ],
  test: {},
});
