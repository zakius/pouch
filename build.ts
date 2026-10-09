import { exec } from "node:child_process";
import packageJson from "./package.json" with { type: "json" };
import manifest from "./src/manifest.json" with { type: "json" };
import {
	copyFile,
	cp,
	mkdir,
	readdir,
	rm,
	watch,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);



async function bumpPatchVersion(): Promise<string> {
	try {
		const currentVersion = packageJson.version;
		
		const versionParts = currentVersion.split(".");
		const major = parseInt(versionParts[0]);
		const minor = parseInt(versionParts[1]);
		const patch = parseInt(versionParts[2]);
		
		const newVersion = `${major}.${minor}.${patch + 1}`;
		
		packageJson.version = newVersion;
		await writeFile("package.json", JSON.stringify(packageJson, null, 2));
		
		manifest.version = newVersion;
		await writeFile("src/manifest.json", JSON.stringify(manifest, null, 2));
		
		console.log(`Version bumped from ${currentVersion} to ${newVersion}`);
		return newVersion;
	} catch (error) {
		console.error("Failed to bump version:", error);
		throw error;
	}
}


async function copyStaticFiles(distDir: string): Promise<void> {
	const srcIconsDir = join("src", "icons");
	const destIconsDir = join(distDir, "icons");
	await mkdir(destIconsDir, { recursive: true });
	const iconFiles = await readdir(srcIconsDir);
	for (const file of iconFiles) {
		const srcPath = join(srcIconsDir, file);
		const destPath = join(destIconsDir, file);
		await copyFile(srcPath, destPath);
	}
}

async function copyManifest(): Promise<void> {
	const distDir = "dist/unpackaged";
	await copyFile(
		"src/manifest.json",
		join(distDir, "manifest.json")
	);
}

async function createArchive(): Promise<void> {
	const distDir = "dist/unpackaged";
	const archiveDir = "dist/packages";
	
	await mkdir(archiveDir, { recursive: true });

	try {
		await execAsync(`web-ext build --source-dir=${distDir} --artifacts-dir=${archiveDir} --overwrite-dest`, {
			env: process.env,
		});
		console.log("Created extension.zip in dist/packages/");
	} catch (error) {
		console.error("Failed to create archive:", error);
		throw error;
	}
}

async function lintExtension(): Promise<void> {
	const distDir = "dist/unpackaged";
	try {
		await execAsync(`web-ext lint --source-dir=${distDir}`, {
			env: process.env,
		});
		console.log("Extension linted successfully");
	} catch (error) {
		console.error("Linting failed:", error);
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
		await execAsync(
			"web-ext sign --api-key=${AMO_API_KEY} --api-secret=${AMO_API_SECRET} --source-dir=dist/unpackaged --artifacts-dir=dist/signed --channel=unlisted --amo-metadata=src/metadata.json",
			{
				env: {
					...process.env,
					AMO_API_KEY: String(AMO_API_KEY),
					AMO_API_SECRET: String(AMO_API_SECRET),
				},
			},
		);
		console.log("Extension signed successfully");
	} catch (error) {
		console.error("Failed to sign extension:", error);
		throw error;
	}
}

const ENTRYPOINTS = [
	"src/background/background.html",
	"src/options/options.html",
	"src/popup/popup.html",
];

async function compileTypeScript(
	distDir: string,
	isWatch = false,
	target: "firefox" | "chromium" = "firefox",
	entrypoints = ENTRYPOINTS,
): Promise<void> {
	try {
		const result = await Bun.build({
			entrypoints,
			outdir: distDir,
			define: { "process.env.POUCH_TARGET": JSON.stringify(target) },
			target: "browser",
			format: "esm",
			sourcemap:  isWatch ? "inline" : false,
			minify: true,
			naming: {
				entry: "[dir]/[name].[ext]",
				chunk: "[dir]/[name]-[hash].[ext]",
				asset: "[dir]/[name]-[hash].[ext]"
			},
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

async function cleanDistDirectory(distDir: string): Promise<void> {
	try {
		await rm(distDir, { recursive: true, force: true });
		console.log(`Cleaned directory: ${distDir}`);
	} catch (error) {
		console.warn(`Warning: Could not clean directory ${distDir}:`, error);
	}
}

async function cleanOldArtifacts(): Promise<void> {
	try {
		const oldFiles = ["extension.zip", "firefox.zip", "chromium-mv3.zip", "chromium-mv2.zip"];
		for (const file of oldFiles) {
			try {
				const filePath = join("dist", "packages", file);
				await rm(filePath, { force: true });
			} catch {
			}
		}
		
		try {
			const signedDir = join("dist", "signed");
			const signedFiles = await readdir(signedDir).catch(() => []);
			for (const file of signedFiles) {
				if (file.endsWith(".xpi")) {
					await rm(join(signedDir, file), { force: true });
				}
			}
		} catch {
		}
		
		const oldDirs = ["firefox", "chromium", "tmp"];
		for (const dir of oldDirs) {
			try {
				await rm(join("dist", dir), { recursive: true, force: true });
			} catch {
			}
		}
	} catch (error) {
		console.warn("Warning: Could not clean old artifacts:", error);
	}
}

async function build(
	skipSigning = false,
	prepareOnly = false,
	isWatch = false,
): Promise<void> {
	const distDir = "dist/unpackaged";

	try {
		await cleanOldArtifacts();
		
		await cleanDistDirectory(distDir);
		
		await mkdir(distDir, { recursive: true });
		await mkdir("dist/packages", { recursive: true });
		await mkdir("dist/signed", { recursive: true });

		await compileTypeScript(distDir, isWatch);

		await copyStaticFiles(distDir);

		await copyManifest();

		if (prepareOnly) {
			console.log("Build preparation complete.");
			return;
		}

		if (skipSigning) {
			console.log(
				"Skipping Firefox extension signing. Creating zip archive instead.",
			);
			await createArchive();
		} else {
			await signFirefoxExtension();
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

async function watchAndBuild(): Promise<void> {
	const srcDir = "src";
	console.log(`Watching for changes in ${srcDir}...`);

	await build(true, true, true);

	const watcher = watch(srcDir, { recursive: true });
	for await (const event of watcher) {
		console.log(`Detected ${event.eventType} in ${event.filename}`);
		try {
			await build(true, true, true);
		} catch (error) {
			console.error("Build failed during watch:", error);
			console.log("Watching for next change...");
		}
	}
}

// Public keys of the Chromium build, which fix its extension IDs (see
// src/utils/chromium.ts). The private keys are only needed to sign a .crx.
const CHROMIUM_KEYS = {
	pouch: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsCO2bl5K9BfklQbp+7CH5MLJJnz1WAthVRBpe4z7Xqkhx5WKuonhXkxK/xAOVOBMg14my8wpI+JffkQ+CVl+jD1EcSnorNGTwhJ4Ud/k6mFadQ+bkhltOSEIbmFqERyKA82lHGCRl60u4WpTUqeYPAiV1Fyh695TNwXifpHr1IXtPvYrL5XnPYYotxnjUWI7AdH7MM9vNo9S3SynAhqn92GN9O5eeLMuaDC4czUAxQiYabxhuzjdx5DPG5JfbZj32tgruCDkFAjmTVeoy6dDShxvJN4M1pE+pb1UTRvSmJhR8zl8sSTVq+/8cE7BfA82PTpA2hDCiPzdfLNi2u6amwIDAQAB",
	quickActions: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAhe6WGTbF4a0Oy/UMt/fDEGvxoMIS0nEeQhOIJSMT+0GOVxXQMyn6xpZUiOONCdGU6UtaQ09+oFKuM1x1B6IdxXXMVG0fFcx1RK9jrDkoFY7Tcil81xhYRJWgm8VoyE9EY7F7K4bQbgsvr8Tv6AiwHi7vcJhyIYryVqIvmsmfN4z7nkRPWYNo2TUqMpS6hHC8/X0exm12/3LmoTPa5fBA7EaKiH4vcJJHCuaQqTvqzVytrVVn1a49QR/P1BREMxHEsm8UkownSoXLqwiTe9AjHTXaUT72zUqTyeaHkCB9QprltMJpkP+4+KtXqaq3Qkrsk3l12nvGZVl4h6fgj8336QIDAQAB",
};
const CHROMIUM_ICONS = {
	"16": "icons/icon-16.png",
	"32": "icons/icon-32.png",
	"48": "icons/icon-48.png",
	"128": "icons/icon-128.png",
};

// The Chromium build, MV3: Pouch without its page action, and Pouch Quick
// Actions, an action that asks Pouch to save the page.
async function buildChromium(): Promise<void> {
	const root = "dist/chromium";
	const pouchDir = join(root, "pouch");
	const quickDir = join(root, "quick-actions");
	await rm(root, { recursive: true, force: true });
	// Service workers instead of background pages.
	await compileTypeScript(pouchDir, false, "chromium", [
		"src/background/background.ts",
		"src/options/options.html",
		"src/popup/popup.html",
	]);
	await compileTypeScript(quickDir, false, "chromium", ["src/quick-actions/background.ts"]);

	const { commands } = manifest;
	const manifests = {
		[pouchDir]: {
			manifest_version: 3,
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			key: CHROMIUM_KEYS.pouch,
			icons: CHROMIUM_ICONS,
			options_ui: manifest.options_ui,
			action: {
				default_icon: CHROMIUM_ICONS,
				default_title: manifest.browser_action.default_title,
				default_popup: manifest.browser_action.default_popup,
			},
			commands: {
				_execute_action: commands._execute_browser_action,
				"toggle-save-page": commands["toggle-save-page"],
			},
			background: { service_worker: "background/background.js", type: "module" },
			permissions: manifest.permissions,
			optional_host_permissions: manifest.optional_permissions,
		},
		[quickDir]: {
			manifest_version: 3,
			name: "Pouch Quick Actions",
			version: manifest.version,
			description: "Saves the current page to Pouch with one click. Needs Pouch.",
			key: CHROMIUM_KEYS.quickActions,
			icons: CHROMIUM_ICONS,
			background: { service_worker: "background.js", type: "module" },
			action: {
				default_icon: { "16": "icons/unsaved-16.png", "32": "icons/unsaved-32.png" },
				// "Save to Pouch" once Pouch reports a page it can save.
				default_title: "Pouch Quick Actions",
			},
		},
	};
	await mkdir("dist/packages", { recursive: true });
	for (const [dir, dirManifest] of Object.entries(manifests)) {
		await writeFile(join(dir, "manifest.json"), JSON.stringify(dirManifest, null, 2));
		await cp("src/chromium/icons", join(dir, "icons"), { recursive: true });
	}
	const version = manifest.version;
	await execAsync(`zip -qr ../../packages/pouch-chromium-${version}.zip .`, { cwd: pouchDir });
	await execAsync(`zip -qr ../../packages/pouch-quick-actions-chromium-${version}.zip .`, {
		cwd: quickDir,
	});
	console.log("Created the Chromium packages in dist/packages/");
}

async function main() {
	// --bump lets the parallel Chromium CI job reach the same version as --sign.
	if (process.argv.includes("--sign") || process.argv.includes("--bump")) {
		await bumpPatchVersion();
	}
	if (process.argv.includes("--chromium")) {
		await buildChromium();
		return;
	}
	const watchMode = process.argv.includes("--watch");
	const skipSigning = !process.argv.includes("--sign");
	const prepareOnly = process.argv.includes("--prepare-only") || watchMode;
	const shouldLint = process.argv.includes("--lint");

	await build(skipSigning, prepareOnly).catch((error) => {
		console.error("Build failed:", error);
		process.exit(1);
	});

	if (shouldLint) {
		await lintExtension().catch((error) => {
			console.error("Lint failed:", error);
			process.exit(1);
		});
	}

	if (watchMode) {
		await watchAndBuild();
	}
}

await main();
