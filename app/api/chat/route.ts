import { mutation, handleChatRequest } from "@/src/server";

async function handlePost(req: Request) {
	return handleChatRequest(req);
}

export const POST = mutation(handlePost);
