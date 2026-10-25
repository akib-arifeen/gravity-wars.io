import { handle } from "./handler.ts"

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env)
  },
} satisfies ExportedHandler<Env>
