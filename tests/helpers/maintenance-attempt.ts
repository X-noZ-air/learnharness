import { randomUUID } from "node:crypto";

export function newDrainAttempt() {
	return { id: randomUUID(), startByMs: Date.now() + 5000 };
}
