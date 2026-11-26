import { mutation, pluginTransport } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePost(request: Request, context: { params: Promise<{ id: string }> }) {
	return pluginTransport.call((await context.params).id, request);
}

export const POST = mutation(handlePost);
