import { proxyAdmin } from "@/lib/proxy";
type Context = { params: Promise<{ path?: string[] }> };
async function forward(request: Request, context: Context) {
  return proxyAdmin(request, await context.params);
}
export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
