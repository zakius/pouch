import { exec } from "node:child_process";
import packageJson from "./package.json" with { type: "json" };
import manifest from "./src/manifest.json" with { type: "json" };
import {
	copyFile,
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
		await execAsync(`web-ext build --source-dir=${distDir} --artifacts-dir=${archiveDir}`, {
			env: process.env,
		});
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

async function compileTypeScript(distDir: string, isWatch = false): Promise<void> {
	try {
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

async function main() {
	const watchMode = process.argv.includes("--watch");
	const skipSigning = !process.argv.includes("--sign");
	const prepareOnly = process.argv.includes("--prepare-only") || watchMode;
	const shouldSign = process.argv.includes("--sign");

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

await main();
