import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-settings-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const { POST } = await import("../app/api/chats/route.ts");
const { GET } = await import("../app/api/chats/[id]/route.ts");
const { PUT } = await import("../app/api/chats/[id]/settings/route.ts");
const { PUT: putSection } = await import("../app/api/settings/[section]/route.ts");
const model = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };

async function createChat() {
	const response = await POST(new Request("http://localhost/api/chats", { method: "POST", body: JSON.stringify({ title: "Fixture" }) }));
	assert.equal(response.status, 200);
	const { id } = await response.json() as { id: string };
	const url = `http://localhost/api/chats/${id}`;
	const context = { params: Promise.resolve({ id }) };
	return {
		put: (settings: unknown) => PUT(new Request(`${url}/settings`, { method: "PUT", body: JSON.stringify(settings) }), context),
		read: async () => {
			const response = await GET(new Request(url), context);
			assert.equal(response.status, 200);
			return (await response.json()).settings;
		},
	};
}

test("a Fast-only PUT preserves newer model and effort settings from another tab", async () => {
	const chat = await createChat();
	assert.equal(await chat.read(), undefined);
	const changed = await chat.put({ model, thinkingLevel: "max" });
	assert.equal(changed.status, 200);
	assert.deepEqual(await changed.json(), { settings: { model, thinkingLevel: "max" } });

	const fast = await chat.put({ fastMode: true });
	const expected = { model, thinkingLevel: "max", fastMode: true };
	assert.equal(fast.status, 200);
	assert.deepEqual(await fast.json(), { settings: expected });
	assert.deepEqual(await chat.read(), expected);
});

test("Fast-only PUT keeps missing overrides absent and an empty PUT still clears settings", async () => {
	const chat = await createChat();
	for (const selection of [{ model }, {}]) {
		assert.equal((await chat.put(selection)).status, 200);
		const fast = await chat.put({ fastMode: false });
		assert.equal(fast.status, 200);
		assert.deepEqual(await fast.json(), { settings: { ...selection, fastMode: false } });
		assert.deepEqual(await chat.read(), { ...selection, fastMode: false });
	}
	assert.equal((await chat.put({})).status, 200);
	assert.deepEqual(await chat.read(), {});
});

test("a chat effort write keeps the current Fast preference", async () => {
	const chat = await createChat();
	assert.equal((await chat.put({ model })).status, 200);
	for (const fastMode of [true, false]) {
		assert.equal((await chat.put({ fastMode })).status, 200);
		assert.equal((await chat.put({ model, thinkingLevel: "max", fastMode: !fastMode })).status, 200);
		assert.deepEqual(await chat.read(), { model, thinkingLevel: "max", fastMode });
	}
	const replacement = { provider: "openai", id: "gpt-5.2" };
	assert.equal((await chat.put({ model: replacement })).status, 200);
	assert.deepEqual(await chat.read(), { model: replacement });
});

test("draft Fast writes preserve current slots and slot writes preserve current Fast", async () => {
	const put = (body: unknown) => putSection(new Request("http://localhost/api/settings/models", {
		method: "PUT", body: JSON.stringify(body),
	}), { params: Promise.resolve({ section: "models" }) });
	const strong = { model, thinkingLevel: "max" };
	const cheap = { model };
	assert.equal((await put({ strong, cheap })).status, 200);
	const fast = await put({ strong: { fastMode: true } });
	assert.equal(fast.status, 200);
	assert.deepEqual((await fast.json()).settings.models, { strong: { ...strong, fastMode: true }, cheap });

	const slots = await put({ strong: { model, fastMode: false }, cheap });
	assert.equal(slots.status, 200);
	assert.deepEqual((await slots.json()).settings.models, { strong: { model, fastMode: true }, cheap });
	const replacement = { provider: "openai", id: "gpt-5.2" };
	const replaced = await put({ strong: { model: replacement }, cheap });
	assert.equal(replaced.status, 200);
	assert.deepEqual((await replaced.json()).settings.models, { strong: { model: replacement }, cheap });
});

test("pinning the inherited model during an effort change preserves Fast", async () => {
	const chat = await createChat();
	assert.equal((await chat.put({})).status, 200);
	assert.equal((await chat.put({ fastMode: true })).status, 200);
	assert.equal((await putSection(new Request("http://localhost/api/settings/models", {
		method: "PUT", body: JSON.stringify({ strong: { model } }),
	}), { params: Promise.resolve({ section: "models" }) })).status, 200);
	assert.deepEqual(await chat.read(), { fastMode: true });

	assert.equal((await chat.put({ model, thinkingLevel: "max" })).status, 200);
	assert.deepEqual(await chat.read(), { model, thinkingLevel: "max", fastMode: true });
});
