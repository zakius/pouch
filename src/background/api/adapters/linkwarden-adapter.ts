import { Effect } from "effect";
import * as v from "valibot";
import { linkwardenConfigSchema, linkwardenSettingsSchema } from "../../../utils/settings-schemas";
export { linkwardenConfigSchema, linkwardenSettingsSchema };
import type { Article } from "../../../types/common";
import { requestJson, validate } from "../effect-api-client";
import {
  ConfigurationFailure,
  IncompleteSnapshotFailure,
  ProviderFailure,
  runOperation,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
} from "../effect-adapter";
import type {
  ReadItLaterAPI,
  SavingArticle,
  SyncOptions,
  SyncResult,
} from "../read-it-later-adapter";

export type LinkwardenSettings = v.InferInput<typeof linkwardenSettingsSchema>;
export type LinkwardenConfig = v.InferInput<typeof linkwardenConfigSchema>;

const formConfig = [
  { name: "url", label: "API URL" },
  { name: "token", label: "API Token" },
];

/** Linkwarden's Prisma `Link`: uploaded PDFs and images have no `url`. */
const linkwardenLinkSchema = v.object({
  id: v.number(),
  name: v.string(),
  url: v.nullable(v.string()),
  createdAt: v.string(),
});
/** POST /api/v1/links and DELETE /api/v1/links/:id answer `{response: Link}`. */
const linkwardenLinkResponseSchema = v.object({ response: linkwardenLinkSchema });
/** GET /api/v1/search; `nextCursor` is the last link id of a full page, or null. */
const linkwardenPageSchema = v.object({
  data: v.object({
    links: v.array(linkwardenLinkSchema),
    nextCursor: v.nullable(v.number()),
  }),
});
/** Every Linkwarden route rejects with `{response: "<message>"}`. */
const linkwardenErrorSchema = v.object({ response: v.string() });

type LinkwardenLink = v.InferOutput<typeof linkwardenLinkSchema>;

/** Error messages may echo request data, so only the rejection itself is kept. */
const providerFailure = (operation: string) => (data: unknown) =>
  v.is(linkwardenErrorSchema, data) ? new ProviderFailure(operation) : undefined;

const toArticle = (item: LinkwardenLink, url: string): Article => ({
  id: item.id,
  title: item.name,
  url,
  created_at: item.createdAt,
});

/** The static API token never enters TokenManager, so it cannot reach refresh or token removal. */
export const createLinkwardenAdapter = Effect.fn("linkwarden.acquire")(function* (
  settings: LinkwardenSettings,
) {
  const parsed = v.safeParse(linkwardenSettingsSchema, settings);
  const token = parsed.success ? parsed.output.apiConfig.token.trim() : "";
  // A missing token must not degrade into an unauthenticated request.
  if (!parsed.success || !token || /[\r\n]/.test(token))
    return yield* Effect.fail(new ConfigurationFailure("linkwarden.acquire"));
  // The configured URL is the instance root, for example https://host.
  const apiUrl = `${parsed.output.apiConfig.url.replace(/\/+$/, "")}/api/v1`;
  const authorization = Effect.succeed(`Bearer ${token}`);

  const request = (
    operation: string,
    endpoint: string,
    options: {
      init?: RequestInit;
      mutation?: "save" | "delete";
      timeoutMs?: number;
      confirms?: v.GenericSchema;
    } = {},
  ) => {
    const { confirms } = options;
    return requestJson({
      operation,
      url: `${apiUrl}${endpoint}`,
      init: options.init,
      mutation: options.mutation,
      timeoutMs: options.timeoutMs,
      authorization,
      providerFailure: providerFailure(operation),
      confirms: confirms && ((data) => v.is(confirms, data)),
    });
  };

  const adapter: EffectAdapter = {
    displayName: "Linkwarden",
    formConfig,
    saveArticle: Effect.fn("linkwarden.save")(function* (article: SavingArticle) {
      // A duplicate URL is a 409 rejection when the user prevents duplicate links.
      const data = yield* request("linkwarden.save", "/links", {
        mutation: "save",
        confirms: linkwardenLinkResponseSchema,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: article.url, name: article.title }),
        },
      });
      const saved = yield* validate(linkwardenLinkResponseSchema, data, "linkwarden.save");
      return toArticle(saved.response, saved.response.url ?? article.url);
    }),
    deleteArticle: Effect.fn("linkwarden.delete")(function* (id: number | string) {
      yield* request("linkwarden.delete", `/links/${encodeURIComponent(String(id))}`, {
        mutation: "delete",
        confirms: linkwardenLinkResponseSchema,
        init: { method: "DELETE" },
      });
    }),
    /**
     * Linkwarden's search has no created-since or modified-since filter
     * (https://docs.linkwarden.app/api/search-links), so every sync walks the whole
     * cursor-paginated listing and returns overwrite mode regardless of the requested mode.
     * Uploaded files without a URL are not articles.
     */
    sync: Effect.fn("linkwarden.sync")(function* (_options?: SyncOptions) {
      const query = new URLSearchParams();
      const seen = new Set<number>();
      const articles: Article[] = [];
      for (let page = 0; ; page++) {
        // Keeps the one-request-per-second pacing of the shared client this replaces.
        if (page > 0) yield* Effect.sleep(1000);
        const data = yield* request("linkwarden.sync", `/search?${query.toString()}`);
        const result = yield* validate(linkwardenPageSchema, data, "linkwarden.sync");
        for (const item of result.data.links)
          if (item.url) articles.push(toArticle(item, item.url));
        const cursor = result.data.nextCursor;
        if (cursor === null) break;
        // A revisited cursor would never end; overwriting from a partial listing would drop articles.
        if (seen.has(cursor))
          return yield* Effect.fail(new IncompleteSnapshotFailure("linkwarden.sync"));
        seen.add(cursor);
        query.set("cursor", String(cursor));
      }
      return {
        articles,
        mode: "overwrite" as const,
        metadata: {
          totalFetched: articles.length,
          totalProcessed: articles.length,
          lastSyncTimestamp: new Date().toISOString(),
          apiVersion: "1.0",
        },
      };
    }),
    testConnection: Effect.gen(function* () {
      const data = yield* request("linkwarden.testConnection", "/search", { timeoutMs: 10000 });
      yield* validate(linkwardenPageSchema, data, "linkwarden.testConnection");
      yield* storageHealthy;
      return true as const;
    }),
  };
  yield* storageHealthy;
  return adapter;
}) satisfies (settings: LinkwardenSettings) => Effect.Effect<EffectAdapter, AcquisitionError>;

/** Legacy entry point removed with the remaining Promise callers in #81. */
export class LinkwardenAdapter implements ReadItLaterAPI<LinkwardenSettings> {
  readonly displayName = "Linkwarden";
  readonly formConfig = formConfig;
  private ready: EffectAdapter | undefined;
  async initialize(settings: LinkwardenSettings): Promise<void> {
    this.ready = await runOperation(createLinkwardenAdapter(settings));
  }
  private api(): EffectAdapter {
    if (!this.ready) throw new ConfigurationFailure("linkwarden.acquire");
    return this.ready;
  }
  testConnection(): Promise<boolean> {
    return runOperation(this.api().testConnection);
  }
  saveArticle(article: SavingArticle): Promise<Article> {
    return runOperation(this.api().saveArticle(article));
  }
  deleteArticle(id: number | string): Promise<void> {
    return runOperation(this.api().deleteArticle(id));
  }
  sync(options?: SyncOptions): Promise<SyncResult> {
    return runOperation(this.api().sync(options));
  }
}
