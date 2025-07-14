import type { Article } from "../../types/common";
import type { BaseSettings } from "../../utils/settings";
export interface SavingArticle {
	url: string;
	title: string;
}
export interface FormConfigItem<TObject> {
	name: keyof TObject;
	label: string;
}
export type FormConfig = FormConfigItem<Record<string, unknown>>[];
export interface ReadItLaterAPI<T extends BaseSettings = BaseSettings> {
	displayName: string;
	initialize(settings: T): Promise<void>;
	testConnection(): Promise<boolean>;
	saveArticle(article: SavingArticle): Promise<Article>;
	deleteArticle(id: number): Promise<void>;
	sync(): Promise<Article[]>;
	formConfig: FormConfig;
}
