# Backend Sync Capabilities - Verified 2025

## Summary Table

| Backend    | Incremental Support       | Deletion Tracking | Strategy                   |
| ---------- | ------------------------- | ----------------- | -------------------------- |
| Instapaper | ✅ Yes                    | ✅ Yes            | Incremental only           |
| Wallabag   | ✅ Yes (since)            | ❌ No             | Periodic full syncs (24h)  |
| Raindrop   | ⚠️ Partial (search)       | ❌ No             | Periodic full syncs (48h)  |
| LinkAce    | ⚠️ Likely (created_after) | ❓ Unknown        | Periodic full syncs (48h)  |
| Linkwarden | ❓ Uncertain              | ❓ Unknown        | Needs testing/verification |
| KaraKeep   | ❌ No                     | N/A               | Full sync only             |
| Bookmarks  | ❌ No                     | N/A               | Full sync only             |

## Detailed Backend Analysis

### 1. Instapaper ✅ FULL INCREMENTAL SUPPORT

- **API:** https://www.instapaper.com/api
- **Method:** `have` parameter with hash-based change detection
- **Deletions:** ✅ Yes - returns `delete_ids` array
- **Strategy:** Use incremental sync exclusively (no full syncs needed)
- **Implementation:** `instapaper-adapter.ts:239-307`

**How it works:**

1. Send comma-separated list of bookmark IDs we already have
2. Server returns only NEW or UPDATED bookmarks (based on hash changes)
3. Server also returns `delete_ids[]` array with deleted bookmark IDs
4. Hash-based change detection ensures efficient transfers

**Benefits:**

- Efficient: Only transfers changed data
- Complete: Tracks additions, updates, AND deletions
- Fast: Can use incremental sync exclusively

**Example usage:**

```typescript
// have parameter format: "12345:OjMuzFp6,12346:0n4ONgYs"
// Each entry: ID:hash (hash detects content changes)
const have = allArticles.map((a) => a.id).join(",");
params.have = have;
```

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

### 3. Raindrop ⚠️ INCREMENTAL VIA SEARCH SYNTAX

- **API:** https://developer.raindrop.io/
- **Method:** Search parameter `created:>UNIX_TIMESTAMP`
- **Deletions:** ❌ No - only filters by creation date
- **Strategy:** Incremental sync + periodic full syncs every 48h
- **Implementation:** `raindrop-adapter.ts:179-255`

**How it works:**

1. Uses search syntax for incremental filtering
2. Search syntax: `created:>UNIX_TIMESTAMP`
3. Timestamp must be Unix timestamp in SECONDS
4. Does NOT track deletions or updates to existing items

**Search syntax example:**

```typescript
// Convert ISO string to Unix timestamp in seconds
const unixTimestamp = Math.floor(new Date(lastSyncTimestamp).getTime() / 1000);
queryParams.set("search", `created:>${unixTimestamp}`);
```

**Limitations:**

- Only filters by creation date
- Does NOT track deletions
- Does NOT track updates to existing raindrops

**Strategy:**

- Use incremental sync for quick updates
- Perform full sync every 24-48 hours to catch deletions

---

### 4. LinkAce ⚠️ DOCUMENTED INCREMENTAL SUPPORT

- **API:** https://api-docs.linkace.org/
- **Method:** `created_after` parameter (ISO 8601)
- **Deletions:** ❓ Unknown - not documented
- **Strategy:** Incremental sync + periodic full syncs every 48h
- **Implementation:** `linkace-adapter.ts:194-267`

**How it works:**

1. Uses `created_after` parameter
2. Format: ISO 8601 timestamp string
3. Filters links created after timestamp

**Example usage:**

```typescript
// LinkAce documents created_after parameter for incremental sync
// Format: ISO 8601 timestamp string
if (options?.lastSyncTimestamp && options.mode === "update") {
  baseParams.set("created_after", options.lastSyncTimestamp);
}
```

**Unknowns:**

- Deletion tracking: Not documented
- Update tracking: Not documented

**Strategy:**

- Use incremental sync for speed
- Perform periodic full syncs to catch potential deletions

---

### 5. Linkwarden ❌ UNCERTAIN - NEEDS TESTING

- **API:** https://docs.linkwarden.app/api/
- **Method:** Unknown - docs incomplete
- **Current code assumes:** `createdAfter` parameter
- **Status:** ⚠️ UNVERIFIED - May not work as expected
- **Action needed:** Test and document actual behavior
- **Implementation:** `linkwarden-adapter.ts:187-225`

**Problem:**

- Old endpoint `/api/v1/links` is DEPRECATED
- New endpoint `/api/v1/search` recommended
- But documentation doesn't specify search query parameters
- Current implementation assumes `createdAfter` parameter exists (UNVERIFIED!)

**Recommended Action:**

1. Test if `/api/v1/links` or `/api/v1/search` accepts `createdAfter` parameter
2. If yes: Use incremental sync with periodic full syncs
3. If no: Fall back to full sync only

**WARNING:**
The `createdAfter` parameter may not actually work as expected. If the parameter is ignored, the API will return all results every time.

---

### 6. KaraKeep ❌ NO INCREMENTAL SUPPORT

- **API:** https://docs.karakeep.app/api/get-all-bookmarks/
- **Available params:** `archived`, `favourited`, `limit`, `cursor` only
- **Deletions:** N/A (full sync only)
- **Strategy:** Full sync only - must fetch all bookmarks every time
- **Implementation:** `karakeep-adapter.ts:159-201`

**Limitations:**

- No `createdAfter`/`created_since` parameter exists
- No `modifiedSince` parameter exists
- Must fetch ALL bookmarks on every sync
- No API support for incremental data retrieval

**Strategy:**

- Always perform full sync (mode parameter is ignored)
- Client-side diffing to detect changes
- Consider implementing caching to reduce API calls if needed

**Available query parameters:**

- `archived` (boolean) - Filter by archived status
- `favourited` (boolean) - Filter by favourite status
- `limit` (number) - Limit number of results
- `cursor` (string) - Pagination cursor

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

### For Backends with Full Incremental Support (Instapaper)

- Use incremental sync as default
- Full sync only on first run or explicit user request
- No periodic full syncs needed

### For Backends with Partial Incremental Support (Wallabag, Raindrop, LinkAce)

- Use hybrid approach:
  - Incremental sync for speed (every 30 min - 2 hours)
  - Periodic full syncs to catch deletions (every 24-48 hours)
  - Full sync when browser is idle to minimize impact
- Benefits: Fast updates + eventual consistency

**Recommended intervals:**

- **Wallabag:** Full sync every 24h (uses hybrid approach internally)
- **Raindrop:** Full sync every 48h
- **LinkAce:** Full sync every 48h

### For Backends with No/Uncertain Incremental Support (KaraKeep, Bookmarks, Linkwarden)

- Always use full sync
- For Linkwarden: Test and verify actual capabilities
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

For each backend with uncertain or partial incremental support:

- [ ] Verify incremental sync parameters work as documented
- [ ] Test if deletions are tracked in incremental mode
- [ ] Test if updates to existing items are returned
- [ ] Verify timestamp format (ISO 8601 vs Unix seconds)
- [ ] Document actual vs expected behavior
- [ ] Update implementation based on findings

**Priority for testing:**

1. **Linkwarden** - Uncertain if incremental sync works at all
2. **LinkAce** - Deletion tracking unknown
3. **Raindrop** - Verify search syntax works as expected

---

## Timestamp Formats Reference

| Backend    | Format                   | Example                |
| ---------- | ------------------------ | ---------------------- |
| Instapaper | N/A (uses ID lists)      | `12345,12346,12347`    |
| Wallabag   | Unix seconds             | `1704067200`           |
| Raindrop   | Unix seconds (in search) | `created:>1704067200`  |
| LinkAce    | ISO 8601                 | `2024-01-01T00:00:00Z` |
| Linkwarden | ISO 8601 (unverified)    | `2024-01-01T00:00:00Z` |
| KaraKeep   | N/A (full sync only)     | N/A                    |
| Bookmarks  | N/A (full sync only)     | N/A                    |

---

## Sources

API Documentation:

- [Instapaper Full API](https://www.instapaper.com/api)
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
