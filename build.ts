import { exec } from "node:child_process";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	watch,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);


async function copyDirectoryContents(srcDir: string, destDir: string): Promise<void> {
	const items = await readdir(srcDir, { withFileTypes: true });
	
	for (const item of items) {
		const srcPath = join(srcDir, item.name);
		const destPath = join(destDir, item.name);
		
		if (item.isDirectory()) {
			await mkdir(destPath, { recursive: true });
			await copyDirectoryContents(srcPath, destPath);
		} else {
			await copyFile(srcPath, destPath);
		}
	}
}

async function bumpPatchVersion(): Promise<string> {
	try {
		// Read current package.json
		const packageJson = JSON.parse(await readFile("package.json", "utf-8"));
		const currentVersion = packageJson.version;
		
		// Parse version (assuming semantic versioning)
		const versionParts = currentVersion.split(".");
		const major = parseInt(versionParts[0]);
		const minor = parseInt(versionParts[1]);
		const patch = parseInt(versionParts[2]);
		
		// Bump patch version
		const newVersion = `${major}.${minor}.${patch + 1}`;
		
		// Update package.json
		packageJson.version = newVersion;
		await writeFile("package.json", JSON.stringify(packageJson, null, 2));
		
		// Update manifest
		const manifest = JSON.parse(await readFile("src/manifest.json", "utf-8"));
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
	
	// Create packages directory
	await mkdir(archiveDir, { recursive: true });

	try {
		// Create ZIP archive
		await execAsync(`cd ${distDir} && zip -r ../../${archiveDir}/extension.zip .`);
		console.log("Created extension.zip in dist/packages/");
	} catch (error) {
		console.error("Failed to create archive:", error);
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
				`web-ext sign --api-key=${AMO_API_KEY} --api-secret=${AMO_API_SECRET} --source-dir=dist/unpackaged --artifacts-dir=dist/signed --channel=unlisted --amo-metadata=src/metadata.json`,
			);
			console.log("Extension signed successfully");
		} catch (error) {
			console.error("Failed to sign extension:", error);
			throw error;
		}
}

async function compileTypeScript(distDir: string, isWatch = false): Promise<void> {
	try {
		// Build TypeScript files directly to dist directory
		const result = await Bun.build({
			entrypoints: [
				"src/background/background.html",
				"src/options/options.html",
				"src/popup/popup.html",
			],
			outdir: distDir,
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
		// Remove the entire dist/unpackaged directory and recreate it
		await rm(distDir, { recursive: true, force: true });
		console.log(`Cleaned directory: ${distDir}`);
	} catch (error) {
		console.warn(`Warning: Could not clean directory ${distDir}:`, error);
	}
}

async function cleanOldArtifacts(): Promise<void> {
	try {
		// Remove old build artifacts from packages directory
		const oldFiles = ["extension.zip", "firefox.zip", "chromium-mv3.zip", "chromium-mv2.zip"];
		for (const file of oldFiles) {
			try {
				await execAsync(`rm -f dist/packages/${file}`);
			} catch {
				// Ignore if file doesn't exist
			}
		}
		
		// Remove old XPI files from signed directory
		try {
			await execAsync(`rm -f dist/signed/*.xpi`);
		} catch {
			// Ignore if no XPI files exist
		}
		
		// Remove old directories
		const oldDirs = ["firefox", "chromium", "tmp"];
		for (const dir of oldDirs) {
			try {
				await execAsync(`rm -rf dist/${dir}`);
			} catch {
				// Ignore if directory doesn't exist
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
		// Clean old artifacts
		await cleanOldArtifacts();
		
		// Clean the main dist directory before building
		await cleanDistDirectory(distDir);
		
		// Create dist directories
		await mkdir(distDir, { recursive: true });
		await mkdir("dist/packages", { recursive: true });
		await mkdir("dist/signed", { recursive: true });

		// Compile TypeScript directly to dist directory
		await compileTypeScript(distDir, isWatch);

		// Copy static files (icons)
		await copyStaticFiles(distDir);

		// Copy manifest
		await copyManifest();

		if (prepareOnly) {
			console.log("Build preparation complete.");
			return;
		}

		// Sign or create archive
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

	// Initial build
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

async function main() {
	const watchMode = process.argv.includes("--watch");
	const skipSigning = !process.argv.includes("--sign");
	const prepareOnly = process.argv.includes("--prepare-only") || watchMode;
	const shouldSign = process.argv.includes("--sign");

	// Bump version if signing (for AMO compatibility)
	if (shouldSign) {
		await bumpPatchVersion();
	}

	await build(skipSigning, prepareOnly).catch((error) => {
		console.error("Build failed:", error);
		process.exit(1);
	});

	if (watchMode) {
		await watchAndBuild();
	}
}

main();
