export const phoneViewport = { width: 412, height: 915, isMobile: true, hasTouch: true, isLandscape: false };
export const rotatedPhoneViewport = { ...phoneViewport, width: phoneViewport.height, height: phoneViewport.width, isLandscape: true };
export const desktopViewport = { width: 1280, height: 800 };
export const ultrawideViewport = { width: 3440, height: 1440 };

const portraits = [
	{ ...phoneViewport, width: 360, height: 800 },
	{ ...phoneViewport, width: 390, height: 844 },
	phoneViewport,
	{ ...phoneViewport, width: 430, height: 932 },
];

export const viewports = [
	...portraits.flatMap(portrait => [
		portrait,
		{ ...portrait, height: 320, isLandscape: true },
	]),
	{ width: 640, height: 480 },
	rotatedPhoneViewport,
	desktopViewport,
	ultrawideViewport,
];

export const modelId = "synthetic-viewport";
export const opening = name => `Explain squares in the ${name} fixture.`;
export const followUp = name => `How many sides does the ${name} fixture square have?`;
export const lesson = "A square has four straight, equal sides and four right angles.";
export const answer = "The fixture square has exactly four sides.";
