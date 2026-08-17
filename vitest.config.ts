// Vitest config (v4 API).
// `cloudflareTest` is a Vite plugin that registers the workers runner; bindings
// (NOTES kv, AI, ASSETS) come from the production wrangler.toml so tests see
// the same environment as the deployed worker. KV is mocked, AI fails open.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Preservation-baseline mode switch (see test/preservation.test.ts).
//   unset            -> ASSERT: test/__fixtures__/preservation-baseline.json
//                       must be reproduced exactly. This is the default so CI
//                       can never silently re-record and mask a regression.
//   PRESERVE=record  -> RECORD: rewrite that fixture from the current tree, and
//                       narrow the run to the preservation suite so no view
//                       snapshot is regenerated as a side effect (see task 7,
//                       which requires reading the snapshot diff before -u).
const recordingBaseline = process.env.PRESERVE === "record";

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
  test: recordingBaseline ? { update: true, include: ["test/preservation.test.ts"] } : {},
});
