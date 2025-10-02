import { logger } from "../utils/logger";

// Cache key for browser storage
const FAVICON_CACHE_KEY = "faviconCache";
const MAX_CACHE_SIZE = 100;

export class FaviconManager {
	private static instance: FaviconManager;
	private loadingPromises: Map<string, Promise<string>> = new Map();

	static getInstance(): FaviconManager {
		if (!FaviconManager.instance) {
			FaviconManager.instance = new FaviconManager();
		}
		return FaviconManager.instance;
	}

	async loadFavicon(hostname: string): Promise<string> {
		// Check if already loading this hostname
		if (this.loadingPromises.has(hostname)) {
			logger.debug("Already loading favicon for", hostname, "- waiting for existing request");
			const existingPromise = this.loadingPromises.get(hostname);
			if (existingPromise) {
				return await existingPromise;
			}
		}

		// Check cache first
		const cached = await this.getCachedFavicon(hostname);
		if (cached) {
			logger.debug("Using cached favicon for", hostname);
			return cached;
		}

		// Create loading promise and store it to prevent duplicate requests
		const loadingPromise = this.loadFaviconInternal(hostname);
		this.loadingPromises.set(hostname, loadingPromise);

		try {
			const result = await loadingPromise;
			return result;
		} finally {
			// Clean up the loading promise
			this.loadingPromises.delete(hostname);
		}
	}

	private async loadFaviconInternal(hostname: string): Promise<string> {
		try {
			logger.debug("Loading favicon for", hostname);

			// Try services sequentially (as requested)
			const services = [
				`https://icon.horse/icon/${hostname}?size=128`,
				`https://api.statvoo.com/favicon/?url=${hostname}&size=128`,
				`https://favicone.com/${hostname}`,
				`https://favicon.yandex.net/favicon/${hostname}`,
				`https://icons.duckduckgo.com/ip3/${hostname}.ico`,
				`https://www.google.com/s2/favicons?domain=${hostname}&sz=64`,
			];

			// Try each service sequentially until one works
			for (let i = 0; i < services.length; i++) {
				const serviceUrl = services[i];
				const serviceName = this.getServiceName(serviceUrl);
				
				logger.debug(`Trying service ${i + 1}/${services.length}: ${serviceName} for ${hostname}`);
				
				try {
					const imageData = await this.loadImageFromUrl(serviceUrl, hostname, serviceName);
					if (imageData) {
						// Cache the successful result
						await this.cacheFavicon(hostname, imageData);
						logger.debug(`✅ Successfully loaded favicon for ${hostname} from ${serviceName}`);
						return imageData;
					} else {
						logger.debug(`❌ ${serviceName} returned no data for ${hostname}`);
					}
				} catch (error) {
					logger.debug(`❌ ${serviceName} failed for ${hostname}:`, error);
				}
			}

		} catch (error) {
			logger.debug("Failed to load favicon for", hostname, error);
		}

		// Fallback to default icon
		const fallback = "icons/icon.svg";
		await this.cacheFavicon(hostname, fallback);
		logger.debug("Using default icon for", hostname);
		return fallback;
	}

	private async loadImageFromUrl(url: string, hostname: string, serviceName: string): Promise<string | null> {
		return new Promise((resolve) => {
			const img = new Image();
			let resolved = false;
			
			const cleanup = () => {
				if (!resolved) {
					resolved = true;
				}
			};
			
			img.onload = () => {
				cleanup();
				
				// Basic validation: check dimensions
				if (img.naturalWidth === 0 || img.naturalHeight === 0) {
					logger.debug(`${serviceName} returned 0x0 image for ${hostname}`);
					resolve(null);
					return;
				}
				
				// Check if image is too large (likely an error page)
				if (img.naturalWidth > 512 || img.naturalHeight > 512) {
					logger.debug(`${serviceName} returned oversized image for ${hostname}: ${img.naturalWidth}x${img.naturalHeight}`);
					resolve(null);
					return;
				}
				
				// Convert to data URI
				try {
					const canvas = document.createElement('canvas');
					const ctx = canvas.getContext('2d');
					
					if (!ctx) {
						logger.debug(`${serviceName} failed to get canvas context for ${hostname}`);
						resolve(null);
						return;
					}
					
					canvas.width = img.naturalWidth;
					canvas.height = img.naturalHeight;
					ctx.drawImage(img, 0, 0);
					
					const dataUri = canvas.toDataURL('image/png');
					logger.debug(`${serviceName} successfully converted image for ${hostname}: ${img.naturalWidth}x${img.naturalHeight}`);
					resolve(dataUri);
					
				} catch (error) {
					logger.debug(`${serviceName} error converting image for ${hostname}:`, error);
					resolve(null);
				}
			};
			
			img.onerror = () => {
				cleanup();
				logger.debug(`${serviceName} failed to load image for ${hostname}`);
				resolve(null);
			};
			
			// Timeout after 3 seconds (reduced since we're trying multiple services in parallel)
			setTimeout(() => {
				cleanup();
				logger.debug(`${serviceName} timeout loading image for ${hostname}`);
				resolve(null);
			}, 3000);
			
			// Set crossOrigin for CORS
			img.crossOrigin = 'anonymous';
			img.src = url;
		});
	}

	private getServiceName(url: string): string {
		if (url.includes('icon.horse')) return 'IconHorse';
		if (url.includes('statvoo.com')) return 'Statvoo';
		if (url.includes('unavatar.io')) return 'Unavatar';
		if (url.includes('favicone.com')) return 'Favicone';
		if (url.includes('yandex.net')) return 'Yandex';
		if (url.includes('duckduckgo.com')) return 'DuckDuckGo';
		if (url.includes('google.com/s2/favicons')) return 'Google';
		return 'Unknown';
	}

	private async cacheFavicon(hostname: string, faviconData: string): Promise<void> {
		try {
			const result = await browser.storage.local.get(FAVICON_CACHE_KEY);
			const faviconCache = result[FAVICON_CACHE_KEY] || {};
			
			faviconCache[hostname] = faviconData;
			
			// Clean up cache if it's too large
			const entries = Object.entries(faviconCache);
			if (entries.length > MAX_CACHE_SIZE) {
				// Keep only the most recent entries
				const recentEntries = entries.slice(-MAX_CACHE_SIZE);
				const cleanedCache = Object.fromEntries(recentEntries);
				await browser.storage.local.set({ [FAVICON_CACHE_KEY]: cleanedCache });
			} else {
				await browser.storage.local.set({ [FAVICON_CACHE_KEY]: faviconCache });
			}
		} catch (error) {
			logger.debug("Failed to cache favicon for", hostname, error);
		}
	}

	async getCachedFavicon(hostname: string): Promise<string | null> {
		try {
			const result = await browser.storage.local.get(FAVICON_CACHE_KEY);
			const faviconCache = result[FAVICON_CACHE_KEY] || {};
			return faviconCache[hostname] || null;
		} catch (error) {
			logger.debug("Failed to get cached favicon for", hostname, error);
			return null;
		}
	}

	async preloadFaviconsForArticles(articles: Array<{ url: string }>): Promise<void> {
		// Extract unique hostnames
		const hostnames = new Set<string>();
		for (const article of articles) {
			try {
				const url = new URL(article.url);
				hostnames.add(url.hostname);
			} catch (error) {
				logger.debug("Invalid URL in article:", article.url, error);
			}
		}

		// Filter out already cached hostnames to avoid unnecessary work
		const hostnameArray = Array.from(hostnames);
		const result = await browser.storage.local.get(FAVICON_CACHE_KEY);
		const faviconCache = result[FAVICON_CACHE_KEY] || {};
		
		const uncachedHostnames = hostnameArray.filter(hostname => !faviconCache[hostname]);

		logger.debug(`Preloading favicons: ${uncachedHostnames.length} uncached domains (${hostnames.size - uncachedHostnames.length} already cached)`);

		if (uncachedHostnames.length === 0) {
			logger.debug("All favicons already cached, skipping preload");
			return;
		}

		// Worker pool: 25 concurrent favicon loaders
		const WORKER_POOL_SIZE = 25;
		const workers: Promise<void>[] = [];
		let hostnameIndex = 0;

		// Create worker pool with proper queue management
		for (let i = 0; i < WORKER_POOL_SIZE; i++) {
			workers.push(this.createFaviconWorker(uncachedHostnames, () => {
				const currentIndex = hostnameIndex;
				hostnameIndex++;
				return currentIndex;
			}));
		}

		// Wait for all workers to complete
		await Promise.allSettled(workers);
		
		logger.debug("Completed favicon preloading for all uncached domains");
	}

	private async createFaviconWorker(hostnames: string[], getNextIndex: () => number): Promise<void> {
		while (true) {
			const index = getNextIndex();
			if (index >= hostnames.length) {
				break; // No more hostnames to process
			}

			const hostname = hostnames[index];
			try {
				await this.loadFavicon(hostname);
			} catch (error) {
				logger.debug("Worker failed to load favicon for", hostname, error);
			}
		}
	}

	async cleanupUnusedFavicons(currentArticles: Array<{ url: string }>): Promise<void> {
		try {
			const result = await browser.storage.local.get(FAVICON_CACHE_KEY);
			const faviconCache = result[FAVICON_CACHE_KEY] || {};

			// Get current hostnames
			const currentHostnames = new Set<string>();
			for (const article of currentArticles) {
				try {
					const url = new URL(article.url);
					currentHostnames.add(url.hostname);
				} catch (error) {
					logger.debug("Invalid URL in article:", article.url, error);
				}
			}

			// Remove unused favicons
			const cachedHostnames = Object.keys(faviconCache);
			let removedCount = 0;

			for (const hostname of cachedHostnames) {
				if (!currentHostnames.has(hostname)) {
					delete faviconCache[hostname];
					removedCount++;
				}
			}

			if (removedCount > 0) {
				await browser.storage.local.set({ [FAVICON_CACHE_KEY]: faviconCache });
				logger.debug("Cleaned up", removedCount, "unused favicons");
			}
		} catch (error) {
			logger.debug("Failed to cleanup unused favicons:", error);
		}
	}
}