import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function verifyNativeRenderers(standalone, fixture) {
	const root = realpathSync(standalone);
	const require = createRequire(path.join(root, "server.js"));
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			if (result.url.startsWith("file:")) {
				const file = realpathSync(fileURLToPath(result.url));
				assert.ok(file.startsWith(root + path.sep), `Renderer import escaped standalone: ${file}`);
			}
			return result;
		},
	});
	try {
		const { Resvg } = require("@resvg/resvg-js");
		const { createCanvas } = require("@napi-rs/canvas");
		const pngSignature = "89504e470d0a1a0a";
		const svg = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
		assert.equal(svg.render().asPng().subarray(0, 8).toString("hex"), pngSignature);

		const pdfModule = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
		const { getDocument } = await import(pathToFileURL(pdfModule).href);
		const fonts = path.resolve(path.dirname(pdfModule), "../../standard_fonts") + path.sep;
		const pdf = getDocument({ data: new Uint8Array(readFileSync(fixture)), standardFontDataUrl: fonts });
		try {
			const document = await pdf.promise;
			const page = await document.getPage(1);
			const viewport = page.getViewport({ scale: 1 });
			const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
			await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
			assert.equal(canvas.toBuffer("image/png").subarray(0, 8).toString("hex"), pngSignature);
		} finally {
			await pdf.destroy();
		}
	} finally {
		hooks.deregister();
	}
	console.log("[smoke-server] native PDF and SVG rendered using only the extracted payload");
}
