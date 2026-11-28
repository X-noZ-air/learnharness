/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { mutation, customProviderGet, customProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = customProviderGet;
export const POST = mutation(customProviderMutation);
export const PATCH = mutation(customProviderMutation);
export const DELETE = mutation(customProviderMutation);
