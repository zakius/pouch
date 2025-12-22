import * as v from "valibot";
import { LogLevel } from "./log-levels";
export const baseSettingsSchema = v.object({
  logLevel: v.picklist(Object.values(LogLevel) as [LogLevel, ...LogLevel[]]),
  normalizeOnSave: v.boolean(),
  normalizeOnCompare: v.boolean(),
});
