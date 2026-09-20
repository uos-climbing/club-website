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

async function loadSessionsApp(userOverride?: any) {
    process.env.JWT_SECRET = 'test-secret';
    vi.resetModules();
    const db = createDbMock();

    vi.doMock('../../backend/db', () => ({ db }));
    vi.doMock('../../backend/middleware/auth', () => ({
        authenticateToken: (req: any, _res: any, next: (...args: any[]) => any) => {
            req.user = userOverride || { id: 'u1', role: 'member', email: 'member@example.com', committeeRoles: [] };
            next();
        },
        requireCommittee: (_req: any, _res: any, next: (...args: any[]) => any) => next()
    }));

    const { default: sessionsRouter } = await import('../../backend/routes/sessions');
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    return { app, db };
}

describe('Sessions Router Branches', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('create session returns 500 when no membership types are configured', async () => {
        const { app, db } = await loadSessionsApp();
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null));
        const res = await request(app)
            .post('/api/sessions')
            .send({
                title: 'T',
                type: 'X',
                date: new Date(Date.now() + 100000).toISOString(),
                capacity: 10
            });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('No membership types configured');
    });

    it('create session returns 400 for invalid required membership', async () => {
        const { app, db } = await loadSessionsApp();
        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, { id: 'basic' }))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null));
        const res = await request(app)
            .post('/api/sessions')
            .send({
                title: 'T',
                type: 'X',
                date: new Date(Date.now() + 100000).toISOString(),
                capacity: 10,
                requiredMembership: 'invalid'
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid required membership type');
    });

    it('booking route covers already-booked, missing-session, past-session and full-session branches', async () => {
        const { app, db } = await loadSessionsApp();
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
            cb(null, { userId: 'u1', sessionId: 's1' })
        );
        const alreadyBooked = await request(app).post('/api/sessions/s1/book');
        expect(alreadyBooked.status).toBe(400);

        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null));
        const noSession = await request(app).post('/api/sessions/s2/book');
        expect(noSession.status).toBe(404);

        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, {
                    capacity: 10,
                    bookedSlots: 0,
                    requiredMembership: 'basic',
                    registrationVisibility: 'all',
                    date: new Date(Date.now() - 60_000).toISOString()
                })
            );
        const past = await request(app).post('/api/sessions/s3/book');
        expect(past.status).toBe(400);

        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, {
                    capacity: 1,
                    bookedSlots: 1,
                    requiredMembership: 'basic',
                    registrationVisibility: 'all',
                    date: new Date(Date.now() + 60_000).toISOString()
                })
            );
        const full = await request(app).post('/api/sessions/s4/book');
        expect(full.status).toBe(400);
    });

    it('booking route rejects committee-only registration and membership DB errors', async () => {
        const { app, db } = await loadSessionsApp({
            id: 'u1',
            role: 'member',
            email: 'member@example.com',
            committeeRoles: []
        });
        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, {
                    capacity: 10,
                    bookedSlots: 0,
                    requiredMembership: 'basic',
                    registrationVisibility: 'committee_only',
                    date: new Date(Date.now() + 60_000).toISOString()
                })
            );
        const committeeOnly = await request(app).post('/api/sessions/s5/book');
        expect(committeeOnly.status).toBe(403);

        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, {
                    capacity: 10,
                    bookedSlots: 0,
                    requiredMembership: 'basic',
                    registrationVisibility: 'all',
                    date: new Date(Date.now() + 60_000).toISOString()
                })
            )
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(new Error('DB Error'), null));
        const membErr = await request(app).post('/api/sessions/s6/book');
        expect(membErr.status).toBe(500);
        expect(membErr.body.error).toBe('Database error checking membership');
    });

    it('cancel/attendee-delete/delete routes hit not-found branches', async () => {
        const { app, db } = await loadSessionsApp();
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null));
        const cancelRes = await request(app).post('/api/sessions/s1/cancel');
        expect(cancelRes.status).toBe(400);

        const originalRun = db.run.getMockImplementation();
        db.run.mockImplementation((sql: string, params: any, cb?: (...args: any[]) => any) => {
            const callback = typeof params === 'function' ? params : cb;
            if (typeof sql === 'string' && sql.includes('DELETE FROM bookings WHERE userId = ? AND sessionId = ?')) {
                if (callback) callback.call({ changes: 0 }, null);
                return db;
            }
            if (typeof sql === 'string' && sql.includes('DELETE FROM sessions WHERE id = ?')) {
                if (callback) callback.call({ changes: 0 }, null);
                return db;
            }
            if (originalRun) return originalRun(sql, params, cb);
            if (callback) callback.call({ changes: 1 }, null);
            return db;
        });
        const attendeeRes = await request(app).delete('/api/sessions/s1/attendees/u2');
        expect(attendeeRes.status).toBe(404);

        const deleteRes = await request(app).delete('/api/sessions/s1');
        expect(deleteRes.status).toBe(404);
    });

    it('list and iCal routes cover token and lookup error branches', async () => {
        const { app, db } = await loadSessionsApp();
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, []));
        const listRes = await request(app).get('/api/sessions').set('Authorization', 'Bearer not-a-valid-jwt');
        expect(listRes.status).toBe(200);

        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null));
        const notFoundIcal = await request(app).get('/api/sessions/ical/bad-token');
        expect(notFoundIcal.status).toBe(404);

        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
            cb(null, { id: 'u1', role: 'member', committeeRole: null })
        );
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(new Error('DB Error'), null));
        const allIcalErr = await request(app).get('/api/sessions/ical/token/all');
        expect(allIcalErr.status).toBe(500);
    });

    it('all-iCal route handles committee visibility path', async () => {
        const { app, db } = await loadSessionsApp();
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
            cb(null, { id: 'u1', role: 'member', committeeRole: null })
        );
        db.all
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, [{ role: 'Chair' }]))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, []));

        const res = await request(app).get('/api/sessions/ical/token2/all');
        expect(res.status).toBe(200);
        expect(res.text).toContain('BEGIN:VCALENDAR');
    });
});
