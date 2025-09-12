import { LogLevel } from "./log-levels";
import { getSettings } from "./settings";

const LOG_LEVEL_NAMES: { [key in LogLevel]: string } = {
	[LogLevel.DEBUG]: "DEBUG",
	[LogLevel.INFO]: "INFO",
	[LogLevel.WARN]: "WARN",
	[LogLevel.ERROR]: "ERROR",
	[LogLevel.NONE]: "NONE",
};
export { LogLevel };
class Logger {
	private logLevel: LogLevel = LogLevel.INFO;
	public async initialize() {
		try {
			const settings = await getSettings();
			this.logLevel = settings.logLevel;
		} catch (error) {
			this.error("Failed to initialize logger settings:", error);
		}
	}
	private pseudonymize(data: unknown): unknown {
		if (typeof data !== "object" || data === null) {
			return data;
		}
		
		// Handle Error objects specially to preserve their properties
		if (data instanceof Error) {
			return {
				name: data.name,
				message: data.message,
				stack: data.stack,
			};
		}
		
		if (Array.isArray(data)) {
			return data.map((item) => this.pseudonymize(item));
		}
		const obj = { ...(data as Record<string, unknown>) };
		for (const key in obj) {
			if (Object.hasOwn(obj, key)) {
				if (
					key === "apiConfig" &&
					typeof obj[key] === "object" &&
					obj[key] !== null &&
					!Array.isArray(obj[key])
				) {
					const apiConfig = obj[key] as Record<string, unknown>;
					const sanitizedApiConfig: Record<string, unknown> = {};
					for (const apiConfigKey in apiConfig) {
						sanitizedApiConfig[apiConfigKey] = "****";
					}
					obj[key] = sanitizedApiConfig;
				} else {
					obj[key] = this.pseudonymize(obj[key]);
				}
			}
		}
		return obj;
	}
	private log(level: LogLevel, message: unknown, ...optionalParams: unknown[]) {
		if (level === LogLevel.NONE) {
			return;
		}
		if (level >= this.logLevel) {
			const prefix = `[${new Date().toISOString()}] [${
				LOG_LEVEL_NAMES[level]
			}]`;
			const sanitizedMessage = this.pseudonymize(message);
			const sanitizedParams = optionalParams.map((p) => this.pseudonymize(p));
			const LOG_FUNCTIONS = {
				[LogLevel.ERROR]: console.error,
				[LogLevel.WARN]: console.warn,
				[LogLevel.INFO]: console.info,
				[LogLevel.DEBUG]: console.debug,
			};
			const logFunction = LOG_FUNCTIONS[level] || console.log;
			logFunction(prefix, sanitizedMessage, ...sanitizedParams);
		}
	}
	public setLevel(level: LogLevel) {
		this.logLevel = level;
	}
	public debug(message: unknown, ...optionalParams: unknown[]) {
		this.log(LogLevel.DEBUG, message, ...optionalParams);
	}
	public info(message: unknown, ...optionalParams: unknown[]) {
		this.log(LogLevel.INFO, message, ...optionalParams);
	}
	public warn(message: unknown, ...optionalParams: unknown[]) {
		this.log(LogLevel.WARN, message, ...optionalParams);
	}
	public error(message: unknown, ...optionalParams: unknown[]) {
		this.log(LogLevel.ERROR, message, ...optionalParams);
	}
}
export const logger = new Logger();
