import { z } from "zod";
import { LogLevel } from "./log-levels";
export const baseSettingsSchema = z.object({
	logLevel: z.nativeEnum(LogLevel),
	normalizeOnSave: z.boolean(),
	normalizeOnCompare: z.boolean(),
});
