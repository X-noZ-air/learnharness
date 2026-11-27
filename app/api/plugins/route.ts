import { mutation, pluginTransport } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return pluginTransport.list(); }
function handlePost(request: Request) { return pluginTransport.refresh(request); }

export const POST = mutation(handlePost);
