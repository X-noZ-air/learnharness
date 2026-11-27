export function maintenanceMessage(text: string): string | undefined {
	try {
		const body = JSON.parse(text);
		if (body?.code === "maintenance" && typeof body.error === "string") return body.error;
	} catch { return undefined; }
	return undefined;
}
