// utils/exportZip.js
// =============================================================================
// Streaming ZIP writer for the business data export.
//
// Replaces `archiver`, whose dependency chain (archiver -> readdir-glob ->
// minimatch) carried two production advisories with no upstream fix. The
// archive this produces is byte-compatible in structure: standard deflate
// entries, correct CRC-32, UTF-8 flagged names, and the same file names the
// endpoint has always exported.
//
// Deliberately narrow: this endpoint only ever appends in-memory buffers, so no
// globwalking or directory scanning is needed. Keeping the surface small is the
// point of the replacement.
// =============================================================================

const yazl = require('yazl');

/**
 * @param {Array<{name: string, data: string|Buffer, mtime?: Date}>} entries
 * @returns {{stream: NodeJS.ReadableStream, done: Promise<number>}} `done`
 *          resolves with the archive byte length once the stream is consumed.
 */
function buildZipStream(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) {
        const err = new Error('An export archive needs at least one entry.');
        err.code = 'EXPORT_EMPTY';
        throw err;
    }

    const zip = new yazl.ZipFile();
    const seen = new Set();

    for (const entry of entries) {
        const name = String((entry && entry.name) || '').replace(/^\/+/, '');
        if (!name) {
            const err = new Error('Every archive entry needs a name.');
            err.code = 'EXPORT_ENTRY_INVALID';
            throw err;
        }
        if (seen.has(name)) {
            // Two entries with the same path produce a corrupt-looking archive
            // in most readers; refuse rather than emit it.
            const err = new Error(`Duplicate archive entry: ${name}`);
            err.code = 'EXPORT_ENTRY_DUPLICATE';
            throw err;
        }
        seen.add(name);

        const raw = entry.data === undefined || entry.data === null ? '' : entry.data;
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
        zip.addBuffer(buffer, name, entry.mtime ? { mtime: entry.mtime } : undefined);
    }

    zip.end();

    let bytes = 0;
    const done = new Promise((resolve, reject) => {
        zip.outputStream.on('data', (chunk) => { bytes += chunk.length; });
        zip.outputStream.on('end', () => resolve(bytes));
        zip.outputStream.on('error', reject);
    });

    return { stream: zip.outputStream, done };
}

module.exports = { buildZipStream };
