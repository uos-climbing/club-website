import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

function createDbMock() {
    const db: any = {
        get: vi.fn((sql: string, params: any[], cb: (...args: any[]) => any) => cb(null, null)),
        all: vi.fn((sql: string, params: any[], cb: (...args: any[]) => any) => cb(null, [])),
        run: vi.fn((sql: string, params: any, cb?: (...args: any[]) => any) => {
            const callback = typeof params === 'function' ? params : cb;
            if (callback) callback.call({ changes: 1 }, null);
            return db;
        }),
        serialize: vi.fn((fn: (...args: any[]) => any) => fn())
    };
    return db;
}

async function loadGearApp() {
    vi.resetModules();
    const db = createDbMock();
    vi.doMock('../../backend/db', () => ({ db }));
    vi.doMock('../../backend/middleware/auth', () => ({
        authenticateToken: (req: any, _res: any, next: (...args: any[]) => any) => {
            req.user = { id: 'u1', role: 'committee' };
            next();
        },
        requireKitSec: (_req: any, _res: any, next: (...args: any[]) => any) => next()
    }));
    vi.doMock('../../backend/services/email', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));

    const { default: gearRouter } = await import('../../backend/routes/gear');
    const app = express();
    app.use(express.json());
    app.use('/api/gear', gearRouter);
    return { app, db };
}

describe('Gear Router Branches', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('request route covers not-found and out-of-stock branches', async () => {
        const { app, db } = await loadGearApp();
        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, { availableQuantity: 0 }));

        const notFound = await request(app).post('/api/gear/g1/request');
        expect(notFound.status).toBe(404);

        const outOfStock = await request(app).post('/api/gear/g2/request');
        expect(outOfStock.status).toBe(400);
        expect(outOfStock.body.error).toBe('Gear out of stock');
    });

    it('approve/reject/return routes cover status guard branches', async () => {
        const { app, db } = await loadGearApp();
        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, { status: 'approved' }))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, { status: 'rejected' }))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, { status: 'pending' }));

        const approve = await request(app).post('/api/gear/requests/r1/approve');
        expect(approve.status).toBe(400);
        expect(approve.body.error).toBe('Request is not pending');

        const reject = await request(app).post('/api/gear/requests/r2/reject');
        expect(reject.status).toBe(400);
        expect(reject.body.error).toBe('Request is not pending');

        const ret = await request(app).post('/api/gear/requests/r3/return');
        expect(ret.status).toBe(400);
        expect(ret.body.error).toBe('Request is not approved');
    });

    it('approve/return routes cover DB error branches during transactions', async () => {
        const { app, db } = await loadGearApp();
        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, { gearId: 'g1', status: 'pending', name: 'User', email: 'u@example.com' })
            )
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, { gearId: 'g1', status: 'approved' })
            );

        const originalRun = db.run.getMockImplementation();
        let approveUpdateHit = false;
        let returnUpdateHit = false;
        db.run.mockImplementation((sql: string, params: any, cb?: (...args: any[]) => any) => {
            const callback = typeof params === 'function' ? params : cb;
            if (
                !approveUpdateHit &&
                typeof sql === 'string' &&
                sql.includes("UPDATE gear_requests SET status = 'approved'")
            ) {
                approveUpdateHit = true;
                if (callback) callback.call({ changes: 0 }, new Error('DB Error'));
                return db;
            }
            if (
                !returnUpdateHit &&
                typeof sql === 'string' &&
                sql.includes("UPDATE gear_requests SET status = 'returned'")
            ) {
                returnUpdateHit = true;
                if (callback) callback.call({ changes: 0 }, new Error('DB Error'));
                return db;
            }
            if (originalRun) return originalRun(sql, params, cb);
            if (callback) callback.call({ changes: 1 }, null);
            return db;
        });

        const approve = await request(app).post('/api/gear/requests/r4/approve');
        expect(approve.status).toBe(500);
        expect(approve.body.error).toBe('DB Error');

        const ret = await request(app).post('/api/gear/requests/r5/return');
        expect(ret.status).toBe(500);
        expect(ret.body.error).toBe('DB Error');
    });
});
