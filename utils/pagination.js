// utils/pagination.js
// =============================================================================
// AZAMAN V2 — CURSOR PAGINATION HELPERS
//
// Phase I (2026-05-25): every list endpoint that previously returned an
// unbounded array (or used offset pagination on a millions-of-rows table)
// migrates to cursor pagination. Offset pagination still works for callers
// that haven't been updated — when `cursor` is absent we fall back to the
// legacy page/limit shape.
//
// Why cursor over offset:
//   - Offset pagination on `(userId, createdAt DESC)` becomes O(N + skip)
//     once tables grow. Page 50 of /notifications scans 1000 rows just to
//     return 20.
//   - Cursor pagination is O(limit) regardless of position — Postgres uses
//     the composite index directly.
//   - Cursor is also append-stable: a row inserted while the user is paging
//     never causes a duplicate or skip, which offset cannot guarantee.
//
// Caller pattern (controller side):
//
//     const { take, cursor, mode } = parsePagination(req.query);
//     const rows = await prisma.foo.findMany({
//         where: { ... },
//         orderBy: { createdAt: 'desc' },
//         take,
//         ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
//     });
//     res.json(buildPageEnvelope(rows, take, mode));
// =============================================================================

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 100;

/**
 * Parse pagination query params. Returns a normalised shape that controllers
 * can pass straight to Prisma.
 *
 * Accepted query params:
 *   - cursor : opaque ID of the LAST row in the previous page. When present,
 *              we ignore `page` entirely and emit a cursor-mode envelope.
 *   - limit  : page size (capped at MAX_LIMIT, defaulted to DEFAULT_LIMIT).
 *   - page   : 1-based page index, used only in legacy mode (no cursor).
 *
 * @param {Record<string, string | string[]>} query
 * @returns {{ take: number, cursor: string|number|null, page: number, skip: number, mode: 'cursor'|'offset' }}
 */
function parsePagination(query = {}) {
    const limitRaw = parseInt(query.limit, 10);
    const take = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const cursorRaw = query.cursor != null ? String(query.cursor).trim() : '';
    if (cursorRaw) {
        // Numeric IDs (Trade, Ad) come through as strings on the wire; convert.
        const cursorNum = Number(cursorRaw);
        const cursor = Number.isFinite(cursorNum) && /^-?\d+$/.test(cursorRaw)
            ? cursorNum
            : cursorRaw;
        return { take, cursor, page: 1, skip: 0, mode: 'cursor' };
    }

    const pageRaw = parseInt(query.page, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    return { take, cursor: null, page, skip: (page - 1) * take, mode: 'offset' };
}

/**
 * Wrap a result array in the envelope shape every Phase-I list endpoint
 * returns. `nextCursor` is the id of the last row when there might be more
 * data; null when the page is the final one.
 *
 * In offset mode we also surface `page`/`limit` so legacy clients keep
 * working without code changes.
 *
 * @param {Array} rows         the fetched rows (already trimmed to `take`)
 * @param {number} take        the page size we asked for
 * @param {'cursor'|'offset'} mode
 * @param {number} [page]      legacy offset-mode page number
 * @param {number|null} [total] optional total count for offset-mode UIs
 * @returns {{ nextCursor: string|number|null, hasMore: boolean, limit: number, page?: number, total?: number }}
 */
function buildPageEnvelope(rows, take, mode, page, total) {
    const hasMore = rows.length === take;
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    const nextCursor = hasMore && lastRow != null ? lastRow.id : null;

    const env = { nextCursor, hasMore, limit: take };
    if (mode === 'offset') {
        env.page = page ?? 1;
        if (typeof total === 'number') env.total = total;
    }
    return env;
}

module.exports = { parsePagination, buildPageEnvelope, DEFAULT_LIMIT, MAX_LIMIT };
