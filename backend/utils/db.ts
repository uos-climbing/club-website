import { db } from '../db';

/** SQLite values accepted by the application's parameterized queries. */
export type SqlValue = string | number | boolean | null | Buffer;
// Route parameters are progressively narrowed at each endpoint; keep this
// boundary broad until all Express route params use explicit string types.
export type SqlParams = unknown[];

/**
 * Promisified SQLite helpers.
 *
 * New code should prefer these over raw db.get/db.all/db.run callbacks —
 * they flatten the callback pyramids that made auth flows hard to follow,
 * while preserving identical error semantics (reject on DB error).
 *
 * For multi-statement transactions use inTransaction(): raw db.serialize()
 * + BEGIN/COMMIT interleaves ACROSS concurrent request handlers (serialize()
 * only sequences statements within one callback), which threw 'cannot start a
 * transaction within a transaction' and crashed the process during a booking
 * rush. inTransaction() serializes whole blocks per process instead.
 */

/** db.get — resolves with the row, or undefined when no row matches; rejects on DB error. */
export function dbGet<T = unknown>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err: Error | null, row: T) => (err ? reject(err) : resolve(row)));
    });
}

/** db.all — resolves with all matching rows (empty array if none); rejects on DB error. */
export function dbAll<T = unknown>(sql: string, params: SqlParams = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err: Error | null, rows: T[]) => (err ? reject(err) : resolve(rows ?? [])));
    });
}

export interface RunResult {
    changes: number;
}

/**
 * db.run — resolves with { changes }; rejects on DB error.
 * Use this for INSERT/UPDATE/DELETE where affected-row counts matter
 * (e.g. capacity-guarded booking updates rely on changes === 0).
 */
export function dbRun(sql: string, params: SqlParams = []): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        // Non-arrow function is required here: `this` carries sqlite3's run metadata.
        db.run(sql, params, function (this: RunResult, err: Error | null) {
            if (err) reject(err);
            else resolve({ changes: this.changes });
        });
    });
}

/**
 * Serialize transactional blocks across concurrent requests.
 *
 * db.serialize() only sequences statements WITHIN one callback — two concurrent
 * request handlers each calling db.serialize() interleave with each other, which
 * made 'BEGIN TRANSACTION' throw 'cannot start a transaction within a transaction'
 * and (with no error callback attached) crash the server under the booking rush.
 * This module-level promise chain guarantees transactional blocks run one at a
 * time per process.
 */
let txChain: Promise<unknown> = Promise.resolve();

/**
 * Thrown from inside an inTransaction() block to abort with a specific HTTP
 * response (contract-specific 4xx/500s like "Session is full"). Route handlers
 * catch this and send status/body verbatim; any other rejection is an
 * unexpected failure and maps to a generic 500. The transaction is rolled back
 * before the error reaches the handler.
 */
export class StagedError extends Error {
    constructor(
        readonly stage: string,
        readonly status: number,
        readonly body: { error: string }
    ) {
        super(`transaction aborted at stage "${stage}": ${body.error}`);
        this.name = 'StagedError';
    }
}

export function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = txChain.then(fn, fn);
    // keep the chain alive regardless of individual failures
    txChain = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

/** db.run with the error-callback contract guaranteed (never emits unhandled errors). */
function txRun(sql: string, params: SqlParams = []): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (this: RunResult, err: Error | null) {
            if (err) reject(err);
            else resolve({ changes: this.changes });
        });
    });
}

/**
 * Run fn inside BEGIN IMMEDIATE … COMMIT/ROLLBACK, serialized via withTransaction.
 * BEGIN IMMEDIATE takes the write lock up front, so concurrent callers queue here
 * instead of failing mid-transaction.
 */
export async function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return withTransaction(async () => {
        await txRun('BEGIN IMMEDIATE');
        try {
            const result = await fn();
            await txRun('COMMIT');
            return result;
        } catch (err) {
            await txRun('ROLLBACK').catch(() => {});
            throw err;
        }
    });
}
