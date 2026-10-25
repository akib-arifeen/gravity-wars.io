import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * Local development uses a fixed, non-production D1 id so `cf dev` and
 * `cf d1 ... --local --persist-to .cloudflare/state` address the same local database.
 * A production build or deploy must provide the real database id through the environment;
 * there is no committed remote id and no remote resource was created for this change.
 */
const LOCAL_D1_ID = "2f6e1a4c-9b3d-4c7e-8a10-5d2c9f7b4e61";

export default defineConfig(({ mode }) => {
  const remoteId = process.env.GW_D1_DATABASE_ID;
  if (mode === "production" && !remoteId) {
    throw new Error("GW_D1_DATABASE_ID is required for a production build or deploy");
  }

  return {
    worker: {
      name: "gravity-wars-daily",
      // cf 1.0.0-beta.21 bundles workerd@2026-10-19; a later date is rejected locally until
      // the CLI's runtime catches up. Raise this with the next cf upgrade.
      compatibilityDate: "2026-10-19",
      entrypoint,
      env: {
        DB: bindings.d1({ name: "gravity-wars-daily", id: remoteId ?? LOCAL_D1_ID }),
        ACTOR_HASH_KEY: bindings.secret(),
      },
      observability: {
        enabled: true,
        logs: { enabled: true, headSamplingRate: 1 },
        traces: { enabled: true, headSamplingRate: 0.01 },
      },
    },
  };
});
