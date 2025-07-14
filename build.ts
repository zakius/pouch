import { exec } from "node:child_process";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	watch,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

type Browser = "firefox" | "chromium" | "chromium-mv2";

interface ManifestV2 {
	manifest_version: 2;
	browser_action: {
		default_icon: Record<string, string>;
		default_title: string;
		default_popup: string;
	};
	page_action: {
		default_icon: Record<string, string>;
		default_title: string;
		show_matches: string[];
	};
	background: {
		page: string;
	};
	browser_specific_settings?: {
		gecko: {
			id: string;
			strict_min_version: string;
		};
	};
	permissions: string[];
	optional_permissions?: string[];
}

interface ManifestV3 {
	manifest_version: 3;
	action: {
		default_icon: Record<string, string>;
		default_title: string;
		default_popup: string;
	};
	background: {
		service_worker: string;
		type: "module";
	};
	permissions: string[];
	host_permissions: string[];
}

interface ManifestBase {
	name: string;
	version: string;
	description: string;
	icons: Record<string, string>;
	options_ui: {
		page: string;
		open_in_tab: boolean;
	};
}

type ManifestTemplate = ManifestBase & {
	browser_action: ManifestV2["browser_action"];
	page_action: ManifestV2["page_action"];
	background: ManifestV2["background"];
	browser_specific_settings?: ManifestV2["browser_specific_settings"];
	permissions: string[];
	host_permissions: string[];
};

type Manifest = (ManifestV2 | ManifestV3) & ManifestBase;

async function copyStaticFiles(
	distDir: string,
	browser: Browser,
): Promise<void> {
	// Copy icons
	const srcIconsDir = join("src", "icons");
	const destIconsDir = join(distDir, "icons");
	await mkdir(destIconsDir, { recursive: true });
	const iconFiles = await readdir(srcIconsDir);
	for (const file of iconFiles) {
		const srcPath = join(srcIconsDir, file);
		const destPath = join(destIconsDir, file);
		await copyFile(srcPath, destPath);
	}

	// Copy HTML and CSS files
	const staticDirs = ["background", "options", "popup"];
	for (const dir of staticDirs) {
		const srcDir = join("src", dir);
		const destDir = join(distDir, dir);
		await mkdir(destDir, { recursive: true });

		// Process HTML files
		const htmlContent = await readFile(join(srcDir, `${dir}.html`), "utf-8");
		const isMV2Chromium = browser === "chromium-mv2";
		const processedHtml = isMV2Chromium
			? htmlContent.replace('type="module"', "")
			: htmlContent;
		await writeFile(join(destDir, `${dir}.html`), processedHtml);

		// Copy CSS files if they exist
		try {
			await copyFile(join(srcDir, `${dir}.css`), join(destDir, `${dir}.css`));
		} catch (_error) {
			// Ignore if CSS file doesn't exist
			console.debug(`No CSS file found for ${dir}`);
		}
	}

	// Copy compiled JavaScript files from tmp directory
	const tmpDir = "dist/tmp";
	for (const dir of staticDirs) {
		const srcDir = join(tmpDir, dir);
		const destDir = join(distDir, dir);
		await mkdir(destDir, { recursive: true });

		// Copy the JavaScript file
		const jsFile = `${dir}.js`;
		const srcPath = join(srcDir, jsFile);
		const destPath = join(destDir, jsFile);
		await copyFile(srcPath, destPath);
	}
}

async function processManifest(browser: Browser): Promise<void> {
	const distDir = `dist/${browser}`;
	const manifestTemplate: ManifestTemplate = JSON.parse(
		await readFile("src/manifest.template.json", "utf-8"),
	);

	let manifest: Manifest;
	const isMV2 = browser === "firefox" || browser === "chromium-mv2";

	if (isMV2) {
		// Firefox-specific modifications (MV2)
		const { host_permissions, ...rest } = manifestTemplate;

		// Convert host_permissions to permissions for MV2
		manifest = {
			...rest,
			manifest_version: 2,
			browser_action: manifestTemplate.browser_action,
			page_action: manifestTemplate.page_action,
			background: manifestTemplate.background,
			permissions: [
				...manifestTemplate.permissions,
				...manifestTemplate.host_permissions,
			],
		};

		// Add browser-specific settings only for Firefox
		if (browser === "firefox") {
			manifest.browser_specific_settings =
				manifestTemplate.browser_specific_settings;
		}
	} else {
		// Chromium-specific modifications (MV3)
		const {
			browser_action,
			page_action,
			background,
			browser_specific_settings,
			...rest
		} = manifestTemplate;

		manifest = {
			...rest,
			manifest_version: 3,
			action: {
				default_icon: browser_action.default_icon,
				default_title: browser_action.default_title,
				default_popup: browser_action.default_popup,
			},
			background: {
				service_worker: "background/background.js",
				type: "module",
			},
			permissions: manifestTemplate.permissions,
			host_permissions: manifestTemplate.host_permissions,
		};
	}

	// Write the processed manifest
	await writeFile(
		join(distDir, "manifest.json"),
		JSON.stringify(manifest, null, 2),
	);
}

async function createArchive(browser: Browser): Promise<void> {
	const distDir = `dist/${browser}`;

	try {
		if (browser === "chromium") {
			// Create ZIP archive for Chromium
			await execAsync(`cd ${distDir} && zip -r ../chromium-mv3.zip .`);
			console.log("Created chromium-mv3.zip for Chromium");
		}
		if (browser === "chromium-mv2") {
			// Create ZIP archive for Chromium
			await execAsync(`cd ${distDir} && zip -r ../chromium-mv2.zip .`);
			console.log("Created chromium-mv2.zip for Chromium MV2");
		}
	} catch (error) {
		console.error(`Failed to create archive for ${browser}:`, error);
		throw error;
	}
}

async function signFirefoxExtension(): Promise<void> {
	const { AMO_API_KEY, AMO_API_SECRET } = process.env;

	if (!AMO_API_KEY || !AMO_API_SECRET) {
		throw new Error(
			"AMO_API_KEY and AMO_API_SECRET must be set in environment variables",
		);
	}

	try {
		// Sign the extension using web-ext
		await execAsync(
			`web-ext sign --api-key=${AMO_API_KEY} --api-secret=${AMO_API_SECRET} --source-dir=dist/firefox --artifacts-dir=dist --channel=unlisted --amo-metadata=src/metadata.json`,
		);
		console.log("Firefox extension signed successfully");
	} catch (error) {
		console.error("Failed to sign Firefox extension:", error);
		throw error;
	}
}

async function compileTypeScript(isWatch = false): Promise<void> {
	try {
		// Create tmp directory for compilation output
		const tmpDir = "dist/tmp";
		await mkdir(tmpDir, { recursive: true });

		// Build TypeScript files
		const result = await Bun.build({
			entrypoints: [
				"src/background/background.ts",
				"src/options/options.ts",
				"src/popup/popup.ts",
			],
			outdir: tmpDir,
			target: "browser",
			format: "esm",
			sourcemap: "inline",
			minify: false,
		});

		if (!result.success) {
			console.error("Build failed:", result.logs);
			if (isWatch) {
				throw new Error("TypeScript compilation failed");
			}
			process.exit(1);
		}

		console.log("TypeScript compiled successfully");
	} catch (error) {
		console.error("TypeScript compilation failed:", error);
		if (isWatch) {
			throw error;
		}
		process.exit(1);
	}
}

async function build(
	browser: Browser,
	skipSigning = false,
	prepareOnly = false,
	isWatch = false,
): Promise<void> {
	const distDir = `dist/${browser}`;

	try {
		// First compile TypeScript to tmp directory
		await compileTypeScript(isWatch);

		// Create browser-specific directory
		await mkdir(distDir, { recursive: true });

		// Copy static files (icons, HTML, CSS) and compiled JavaScript
		await copyStaticFiles(distDir, browser);

		// Process and copy manifest
		await processManifest(browser);

		if (prepareOnly) {
			console.log("Build preparation complete.");
			return;
		}

		// Sign or create archive
		if (browser === "firefox") {
			if (skipSigning) {
				console.log(
					"Skipping Firefox extension signing. Creating zip archive instead.",
				);
				await createArchive(browser);
			} else {
				await signFirefoxExtension();
			}
		} else {
			// For chromium builds
			await createArchive(browser);
		}

		console.log("Build finished.");
	} catch (error) {
		console.error("Build failed:", error);
		if (isWatch) {
			throw error;
		}
		process.exit(1);
	}
}

async function watchAndBuild(browser: Browser): Promise<void> {
	const srcDir = "src";
	console.log(`Watching for changes in ${srcDir} to build for ${browser}...`);

	// Initial build
	await build(browser, true, true, true);

	const watcher = watch(srcDir, { recursive: true });
	for await (const event of watcher) {
		console.log(`Detected ${event.eventType} in ${event.filename}`);
		try {
			await build(browser, true, true, true);
		} catch (error) {
			console.error("Build failed during watch:", error);
			console.log("Watching for next change...");
		}
	}
}

async function main() {
	const targetBrowser = process.argv[2] as Browser;
	const watchMode = process.argv.includes("--watch");
	const skipSigning = process.argv.includes("--skip-signing");
	const prepareOnly = process.argv.includes("--prepare-only") || watchMode;

	if (!["firefox", "chromium", "chromium-mv2"].includes(targetBrowser)) {
		console.error(
			'Invalid browser specified. Use "firefox", "chromium" or "chromium-mv2".',
		);
		process.exit(1);
	}

	await build(targetBrowser, skipSigning, prepareOnly).catch((error) => {
		console.error("Build failed:", error);
		process.exit(1);
	});

	if (watchMode) {
		await watchAndBuild(targetBrowser);
	}
}

main();
