import { handle } from "./handler.ts"
import { structuredError, structuredLog } from "./http.ts"
import { runRetention } from "./retention.ts"

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env)
  },

  /**
   * The bounded retention sweep (see retention.ts). It runs hourly from the cron trigger in
   * cloudflare.config.ts, deletes only rows whose window has provably passed, and stops itself on
   * a batch count and a wall-clock budget, so the event cannot run long.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now()
    try {
      const report = await runRetention(env.DB, now)
      structuredLog("retention", { cron: controller.cron, scheduledTime: controller.scheduledTime, ...report })
    } catch (error) {
      structuredError("retention_error", {
        cron: controller.cron,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },
} satisfies ExportedHandler<Env>
