// Keep the CSS width fixed across orientations so each landscape case
// exercises the narrow layout with less vertical room.
export const viewports = [
	...[360, 390, 412, 430].flatMap((width, index) => [
		{ width, height: [800, 844, 915, 932][index], isMobile: true, hasTouch: true, isLandscape: false },
		{ width, height: 320, isMobile: true, hasTouch: true, isLandscape: true },
	]),
	{ width: 640, height: 480 },
	{ width: 1280, height: 800 },
];

export const modelId = "synthetic-viewport";
export const opening = name => `Explain squares in the ${name} fixture.`;
export const followUp = name => `How many sides does the ${name} fixture square have?`;
export const lesson = "A square has four straight, equal sides and four right angles.";
export const answer = "The fixture square has exactly four sides.";
