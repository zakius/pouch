# Backend Sync Capabilities - Verified 2025

## Summary Table

| Backend    | Incremental Support                     | Deletion Tracking                   | Strategy                                                         |
| ---------- | --------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Instapaper | ✅ Yes (API v2 `since`)                 | ✅ Yes (`deleted_ids` + `archived`) | True incremental sync + periodic full syncs (24h idle / 48h max) |
| Wallabag   | ✅ Yes (since)                          | ❌ No                               | Periodic full syncs (24h)                                        |
| Raindrop   | ⚠️ Partial (`sort=-created` early-stop) | ❌ No                               | Periodic full syncs (24h idle / 48h max)                         |
| LinkAce    | ❌ No                                   | N/A                                 | Full sync only                                                   |
| Linkwarden | ⚠️ Partial (`sort=0` ID early-stop)     | ❌ No                               | Periodic full syncs (24h idle / 48h max)                         |
| KaraKeep   | ❌ No                                   | N/A                                 | Full sync only                                                   |
| Bookmarks  | ❌ No                                   | N/A                                 | Full sync only                                                   |

## Detailed Backend Analysis

### 1. Instapaper ✅ FULL INCREMENTAL SUPPORT WITH DELETIONS (API v2)

- **API:** https://www.instapaper.com/developers/v2 (`GET /api/2/bookmarks`, OpenAPI: `https://www.instapaper.com/api/2/openapi.json`)
- **Authentication:** OAuth 2 / personal Bearer token (`Authorization: Bearer <token>`); legacy v1 `oauth_token` persisted in `TokenManager` is automatically reused as a v2 Bearer token during migration
- **Method:** `offset`/`total` pagination (`limit=500`) for full snapshots (`section=home`), and `since` (Unix seconds with 120s clock-skew overlap) for incremental syncs
- **Deletions:** ✅ Yes — `since` responses include `deleted_ids` for permanently deleted bookmarks and return archived bookmarks with `archived: true`; both are surfaced in `SyncResult.deletedIds` and purged from `ArticlesRepository` cache during `"update"` merges
- **Strategy:** Hybrid incremental sync (`since`) + periodic full syncs (24h when idle, forced at 48h) as a reconciliation safety net
- **Implementation:** `instapaper-adapter.ts`

**How it works:**

1. Full (`"overwrite"`) sync paginates `GET /api/2/bookmarks?section=home&limit=500&offset=<n>` until `offset >= total`, removing API v1's 500-bookmark cap
2. Incremental (`"update"`) sync requests `GET /api/2/bookmarks?limit=500&offset=<n>&since=<unix>` with `since = Math.floor(lastSyncMs / 1000) - 120`
3. Per the API v2 OpenAPI spec, changed bookmarks and `deleted_ids` share each page in `since` mode; `offset` advances by `bookmarks.length + deleted_ids.length` and stops when a page returns fewer than `limit` combined items or `offset >= total`
4. Bookmarks returned with `archived: true` in `since` mode are added to `deletedIds` so they are removed from the local unread cache; un-archived bookmarks (`archived: false`) are merged back in
5. Bookmarks with `url: null` (private content without a URL) are skipped cleanly without stalling pagination
6. Deduplicates bookmark IDs across pages and fails with `IncompleteSnapshotFailure` if a page makes no progress (`newItemsOnPage === 0`) or returns empty while `offset < total`

**Hybrid Strategy:**

- First sync or missing/invalid `lastSyncTimestamp` → FULL (`overwrite`)
- Last full sync ≥ 48h ago → FULL (`overwrite`)
- Last full sync ≥ 24h ago + browser idle → FULL (`overwrite`)
- Otherwise → INCREMENTAL (`update` with `since` + `deleted_ids`)

---

### 2. Wallabag ⚠️ INCREMENTAL WITH LIMITATIONS

- **API:** https://doc.wallabag.org/developer/api/
- **Method:** `since` parameter (Unix timestamp in seconds)
- **Deletions:** ❌ No - deleted entries not returned
- **Strategy:** Incremental sync + periodic full syncs every 24h
- **Implementation:** `wallabag-adapter.ts:363-481`

**How it works:**

1. Use `since` parameter with Unix timestamp (in seconds!)
2. Fetches entries modified/created after timestamp
3. Does NOT track deletions
4. Periodic full syncs (every 24h when idle) catch deletions

**Limitations:**

- Deleted entries only caught during full sync
- Requires careful sync mode decision logic

**Timestamp conversion:**

```typescript
// Convert ISO timestamp to Unix seconds
const unixTimestamp = Math.floor(new Date(lastSyncTimestamp).getTime() / 1000);
params.set("since", unixTimestamp.toString());
```

**Hybrid Strategy:**

- First sync → FULL (baseline)
- Last full sync >24h ago + browser idle → FULL (catch deletions)
- Otherwise → INCREMENTAL (fast update)

---

### 3. Raindrop ⚠️ INCREMENTAL VIA `sort=-created` EARLY-STOP

- **API:** https://developer.raindrop.io/
- **Method:** Paginate `GET /raindrops/0?page=<p>&perpage=50&sort=-created` and stop early client-side once `created < lastSyncTimestamp - 120s`
- **Deletions:** ❌ No - incremental sync only captures newly created raindrops
- **Strategy:** Hybrid incremental sync + periodic full syncs (24h when idle, forced at 48h)
- **Implementation:** `raindrop-adapter.ts`

**How it works:**

1. Requests pages ordered newest-first (`sort=-created`) without a `search` parameter (Raindrop's `created:` search operator only supports calendar dates `YYYY-MM-DD`, not Unix timestamps)
2. In `"update"` mode, computes a cutoff `Date.parse(lastSyncTimestamp) - 120_000` (2-minute clock-skew overlap)
3. Keeps items with unparseable `created` or `created >= cutoffMs`; once an item older than `cutoffMs` is seen, finishes the current page and stops paginating early
4. Deduplicates items by `_id` across pages and fails with `IncompleteSnapshotFailure` if a full page yields no new IDs
5. Falls back to `"overwrite"` when `lastSyncTimestamp` is missing/invalid, on first sync, after 24h when idle, or after 48h overdue

**Limitations:**

- Only captures newly created raindrops during incremental sync
- Does NOT track deletions (reconciled on periodic full syncs)
- Does NOT track updates to older existing raindrops (reconciled on periodic full syncs)

**Hybrid Strategy:**

- First sync or missing/invalid `lastSyncTimestamp` → FULL (`overwrite`)
- Last full sync ≥ 48h ago → FULL (`overwrite`)
- Last full sync ≥ 24h ago + browser idle → FULL (`overwrite`)
- Otherwise → INCREMENTAL (`update`)

---

### 4. LinkAce ❌ NO INCREMENTAL SUPPORT

- **API:** https://api-docs.linkace.org/
- **Endpoint:** `GET /api/v2/links?per_page=200&order_by=id&order_dir=asc&page=<n>`
- **Method:** Full sync only (`GET /api/v2/links` does not support `created_after` or `modified_since`)
- **Deletions:** N/A (full sync only; always returns `mode: "overwrite"` so deletions are reconciled on every sync)
- **Strategy:** Full sync only - fetch all links ordered by ascending ID with `per_page=200` and 1s inter-page pacing (for LinkAce's default 60 req/min rate limit)
- **Implementation:** `linkace-adapter.ts`

**How it works:**

1. Requests `GET /api/v2/links` with `per_page=200`, `order_by=id`, `order_dir=asc`, and `page=<n>`
2. Ascending ID ordering keeps newly inserted links at the tail so earlier pages do not shift during pagination
3. Deduplicates links by `id` across pages and fails with `IncompleteSnapshotFailure` if `current_page` mismatches or a non-empty page yields no new IDs
4. Always returns `mode: "overwrite"` even when a caller requests `"update"`, ensuring deletions are reconciled after every full fetch

**Limitations:**

- `GET /api/v2/links` in LinkAce v2 does not support `created_after` or any timestamp filter (verified against `API/LinkController::index` and the OpenAPI spec)
- Must fetch all links on every sync
- Default API rate limit is 60 requests/minute, so multi-page sync pauses 1s between pages

---

### 5. Linkwarden ⚠️ INCREMENTAL VIA `sort=0` ID EARLY-STOP

- **API:** https://docs.linkwarden.app/api/
- **Endpoint:** `GET /api/v1/search?sort=0` (cursor-paginated via `cursor=<nextCursor>`)
- **Method:** Paginate `GET /api/v1/search?sort=0` (ordered strictly by `id desc`, without pinned-first ordering) and stop early client-side once any link on the page has `id <= maxKnownNumericId`
- **Deletions:** ❌ No - incremental sync only captures newly created links
- **Strategy:** Hybrid incremental sync + periodic full syncs (24h when idle, forced at 48h)
- **Implementation:** `linkwarden-adapter.ts`

**How it works:**

1. Requests pages ordered strictly by descending numeric ID (`sort=0`) — `/api/v1/search` has no `createdAfter` or `modifiedSince` parameter
2. `ArticlesRepository.syncAccount` computes `maxKnownNumericId` from cached articles so incremental sync survives Chromium MV3 service worker restarts
3. In `"update"` mode, keeps only links with `link.id > maxKnownNumericId` and stops paginating early as soon as any link on the page has `link.id <= maxKnownNumericId`
4. In `"overwrite"` mode, walks all pages, deduplicates links by `id`, and fails with `IncompleteSnapshotFailure` if `nextCursor` repeats
5. Falls back to `"overwrite"` on first sync, when `maxKnownNumericId` is missing, after 24h when idle, or after 48h overdue

**Limitations:**

- Only captures newly created links during incremental sync
- Does NOT track deletions (reconciled on periodic full syncs)
- Does NOT track updates to older existing links (reconciled on periodic full syncs)
- Requires Linkwarden 2.10 or later (`/api/v1/search`; older `/api/v1/links` is deprecated)

**Hybrid Strategy:**

- First sync or missing `maxKnownNumericId` → FULL (`overwrite`)
- Last full sync ≥ 48h ago → FULL (`overwrite`)
- Last full sync ≥ 24h ago + browser idle → FULL (`overwrite`)
- Otherwise → INCREMENTAL (`update`)

---

### 6. KaraKeep ❌ NO INCREMENTAL SUPPORT

- **API:** https://docs.karakeep.app/api/get-all-bookmarks/
- **Endpoint:** `GET /api/v1/bookmarks?limit=100&includeContent=false&archived=false` (`archived` omitted when `includeArchived` is enabled; `cursor` on subsequent pages)
- **Available params:** `archived`, `favourited`, `limit`, `cursor`, `includeContent`, `sortOrder`
- **Deletions:** N/A (full sync only; always returns `mode: "overwrite"`)
- **Strategy:** Full sync only - fetches active bookmarks by default (`archived=false`, configurable via `includeArchived`), unarchiving re-saved archived duplicates on pre-v0.33.1 servers via `PATCH /api/v1/bookmarks/:id`
- **Implementation:** `karakeep-adapter.ts`

**Limitations:**

- No `createdAfter`/`created_since` parameter exists
- No `modifiedSince` parameter exists
- Must fetch ALL bookmarks on every sync
- No API support for incremental data retrieval

**Strategy:**

- Always perform full sync (`mode` parameter is ignored; always returns `"overwrite"`)
- Passes `includeContent=false` to omit large crawled HTML/text payloads and deduplicates bookmark IDs across pages
- Client-side diffing to detect changes

**Available query parameters:**

- `archived` (boolean) - Filter by archived status
- `favourited` (boolean) - Filter by favourite status
- `limit` (number) - Limit number of results (max 100)
- `cursor` (string) - Pagination cursor
- `includeContent` (boolean) - Include crawled HTML/text content (`false` keeps responses compact)
- `sortOrder` (`asc` | `desc`) - Result sort order

---

### 7. Bookmarks ❌ NO INCREMENTAL SUPPORT

- **API:** Firefox Extension Bookmarks API
- **Method:** None - native browser API
- **Strategy:** Full sync only - fetch all from Pouch folder
- **Implementation:** `bookmarks-adapter.ts:112-138`

**Limitations:**

- Native Firefox Bookmarks API doesn't support date-based filtering
- Must fetch all bookmarks from Pouch folder
- No incremental sync capabilities

**Strategy:**

- Always use full sync
- Consider client-side caching and diffing

---

## Sync Strategy Recommendations

### For Backends with Full Incremental Support (Instapaper v2)

- Use `since` incremental sync with `deleted_ids` and `archived` removal handling for fast, accurate updates
- Keep periodic full syncs (24h idle / 48h max) as a reconciliation safety net

### For Backends with Partial Incremental Support (Wallabag, Raindrop, Linkwarden)

- Use hybrid approach:
  - Incremental sync for speed (every 30 min - 2 hours)
  - Periodic full syncs to catch deletions (every 24-48 hours)
  - Full sync when browser is idle to minimize impact
- Benefits: Fast updates + eventual consistency

**Recommended intervals:**

- **Instapaper:** Incremental `since` + `deleted_ids` sync; full sync every 24h when idle, or 48h max
- **Wallabag:** Full sync every 24h (uses hybrid approach internally)
- **Raindrop:** Full sync every 24h when idle, or 48h max (uses hybrid approach internally)
- **Linkwarden:** Full sync every 24h when idle, or 48h max (uses hybrid ID-based early-stop internally)

### For Backends with No Incremental Support (LinkAce, KaraKeep, Bookmarks)

- Always use full sync (and return `mode: "overwrite"` so deletions are reconciled)
- Consider client-side caching to reduce perceived latency

---

## Implementation Guidelines

All adapters should:

1. ✅ Support both `mode: "overwrite"` and `mode: "update"`
2. ✅ Handle `lastSyncTimestamp` appropriately for their capabilities
3. ✅ Document limitations clearly in code comments
4. ✅ Log sync mode decisions for debugging
5. ⚠️ Fall back gracefully if incremental sync fails

---

## Testing Checklist

For each backend with partial incremental support:

- [ ] Verify incremental sync parameters / early-stop conditions work as documented
- [ ] Test if deletions are tracked in incremental mode
- [ ] Test if updates to existing items are returned
- [ ] Verify cursor / timestamp format (ID vs ISO 8601 vs Unix seconds)
- [ ] Document actual vs expected behavior
- [ ] Update implementation based on findings

---

## Timestamp Formats Reference

| Backend    | Format                            | Example                |
| ---------- | --------------------------------- | ---------------------- |
| Instapaper | Unix seconds (`since`)            | `1704067200`           |
| Wallabag   | Unix seconds                      | `1704067200`           |
| Raindrop   | ISO 8601 (client-side early-stop) | `2024-01-01T00:00:00Z` |
| LinkAce    | N/A (full sync only)              | N/A                    |
| Linkwarden | N/A (numeric ID early-stop)       | `12345`                |
| KaraKeep   | N/A (full sync only)              | N/A                    |
| Bookmarks  | N/A (full sync only)              | N/A                    |

---

## Sources

API Documentation:

- [Instapaper API v2](https://www.instapaper.com/developers/v2) ([OpenAPI](https://www.instapaper.com/api/2/openapi.json))
- [Raindrop.io API](https://developer.raindrop.io/)
- [Wallabag API Documentation](https://doc.wallabag.org/developer/api/)
- [LinkAce API Reference](https://api-docs.linkace.org/)
- [Linkwarden API Documentation](https://docs.linkwarden.app/api/)
- [KaraKeep API Documentation](https://docs.karakeep.app/api/get-all-bookmarks/)
- [Firefox Bookmarks API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/bookmarks)

---

## Version History

- **2025-01-08:** Initial documentation created
  - Verified all backend API capabilities
  - Fixed KaraKeep (removed non-existent incremental sync)
  - Fixed Raindrop datetime format bug
  - Improved Wallabag documentation
  - Added comprehensive comments to all adapters
  - Documented Linkwarden uncertainty
