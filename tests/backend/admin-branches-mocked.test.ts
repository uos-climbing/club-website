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
        prepare: vi.fn(() => ({
            run: vi.fn(),
            finalize: vi.fn((cb?: (...args: any[]) => any) => cb && cb(null))
        }))
    };
    return db;
}

async function loadAdminApp(root = true) {
    vi.resetModules();
    const db = createDbMock();
    vi.doMock('../../backend/db', () => ({ db }));
    vi.doMock('../../backend/services/email', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
    vi.doMock('../../backend/middleware/auth', () => ({
        authenticateToken: (req: any, _res: any, next: (...args: any[]) => any) => {
            req.user = root
                ? { id: 'u1', role: 'committee', email: 'committee@sheffieldclimbing.org' }
                : { id: 'u2', role: 'committee', email: 'member@example.com' };
            next();
        },
        requireCommittee: (_req: any, _res: any, next: (...args: any[]) => any) => next()
    }));
    const { default: adminRouter } = await import('../../backend/routes/admin');
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    return { app, db };
}

describe('Admin Mocked Branches', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('users route returns 500 when memberships fetch fails', async () => {
        const { app, db } = await loadAdminApp();
        db.all
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, [{ id: 'u1' }]))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(new Error('DB Error'), null));
        const res = await request(app).get('/api/admin/users');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
    });

    it('users route returns 500 when committee roles fetch fails', async () => {
        const { app, db } = await loadAdminApp();
        db.all
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, [{ id: 'u1' }]))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, []))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(new Error('DB Error'), null));
        const res = await request(app).get('/api/admin/users');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
    });

    it('committee-role assignment returns 500 for available role lookup failure', async () => {
        const { app, db } = await loadAdminApp();
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(new Error('DB Error'), null));
        const res = await request(app)
            .post('/api/admin/users/u1/committee-role')
            .send({ committeeRoles: ['Chair'] });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
    });

    it('committee-role assignment returns 500 when role delete fails', async () => {
        const { app, db } = await loadAdminApp();
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, [{ id: 'Chair' }]));
        const originalRun = db.run.getMockImplementation();
        db.run.mockImplementation((sql: string, params: any, cb?: (...args: any[]) => any) => {
            const callback = typeof params === 'function' ? params : cb;
            if (typeof sql === 'string' && sql.includes('DELETE FROM committee_roles')) {
                if (callback) callback.call({ changes: 0 }, new Error('DB Error'));
                return db;
            }
            if (originalRun) return originalRun(sql, params, cb);
            if (callback) callback.call({ changes: 1 }, null);
            return db;
        });
        const res = await request(app)
            .post('/api/admin/users/u1/committee-role')
            .send({ committeeRoles: ['Chair'] });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
    });

    it('committee-role assignment returns 500 when role insert fails', async () => {
        const { app, db } = await loadAdminApp();
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, [{ id: 'Chair' }]));
        db.run.mockImplementation((sql: string, params: any, cb?: (...args: any[]) => any) => {
            if (sql.includes('INSERT OR IGNORE INTO committee_roles')) {
                throw new Error('DB Error'); // rejected by the promise wrapper -> route returns 500
            }
            const callback = typeof params === 'function' ? params : cb;
            if (callback) callback.call({ changes: 1 }, null);
            return db;
        });
        const res = await request(app)
            .post('/api/admin/users/u1/committee-role')
            .send({ committeeRoles: ['Chair'] });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
    });

    it('committee role create validates required fields', async () => {
        const { app } = await loadAdminApp();
        const res = await request(app).post('/api/admin/committee-roles').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Role ID and label are required');
    });

    it('committee role update returns 500 on DB error', async () => {
        const { app, db } = await loadAdminApp();
        db.run.mockImplementationOnce((_sql: string, _params: any[], cb: any) => {
            cb.call({ changes: 0 }, new Error('DB Error'));
            return db;
        });
        const res = await request(app).put('/api/admin/committee-roles/r1').send({ label: 'X' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
    });

    it('committee role delete returns 500 on count-query error', async () => {
        const { app, db } = await loadAdminApp();
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(new Error('DB Error'), null));
        const res = await request(app).delete('/api/admin/committee-roles/r1');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
    });

    it('committee role delete returns 500 on delete query error', async () => {
        const { app, db } = await loadAdminApp();
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, { count: 0 }));
        db.run.mockImplementationOnce((_sql: string, _params: any[], cb: any) => {
            cb.call({ changes: 0 }, new Error('DB Error'));
            return db;
        });
        const res = await request(app).delete('/api/admin/committee-roles/r1');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
    });

    it('non-root committee cannot update role definitions', async () => {
        const { app } = await loadAdminApp(false);
        const res = await request(app).put('/api/admin/committee-roles/r1').send({ label: 'X' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Only Root Admin can perform this action');
    });

    it('membership approve/reject/delete for non-basic rows succeed without top-level status update', async () => {
        const { app, db } = await loadAdminApp();
        db.get
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, { id: 'm1', userId: 'u1', membershipType: 'comp_team', membershipYear: '2025/2026' })
            )
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, { id: 'm2', userId: 'u1', membershipType: 'comp_team', membershipYear: '2025/2026' })
            )
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null))
            .mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
                cb(null, { id: 'm3', userId: 'u1', membershipType: 'comp_team', membershipYear: '2025/2026' })
            );

        const approveRes = await request(app).post('/api/admin/memberships/m1/approve');
        expect(approveRes.status).toBe(200);

        const rejectRes = await request(app).post('/api/admin/memberships/m2/reject');
        expect(rejectRes.status).toBe(200);

        const deleteRes = await request(app).delete('/api/admin/memberships/m3');
        expect(deleteRes.status).toBe(200);
    });
});
