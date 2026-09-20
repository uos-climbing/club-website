import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import bcrypt from 'bcrypt';

function createDbMock() {
    const db: any = {
        all: vi.fn((sql: string, params: any[], cb: (...args: any[]) => any) => cb(null, [])),
        get: vi.fn((sql: string, params: any[], cb: (...args: any[]) => any) => cb(null, null)),
        run: vi.fn((sql: string, params: any, cb?: (...args: any[]) => any) => {
            const callback = typeof params === 'function' ? params : cb;
            if (callback) callback.call({ changes: 1 }, null);
            return db;
        }),
        prepare: vi.fn(() => ({
            run: vi.fn(),
            finalize: vi.fn()
        }))
    };
    return db;
}

async function loadAuthApp(nodeEnv: string) {
    process.env.NODE_ENV = nodeEnv;
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.APP_URL;
    delete process.env.AUTH_RATE_LIMIT_ENABLED;
    vi.resetModules();

    const db = createDbMock();
    const sendEmail = vi.fn().mockResolvedValue(true);

    vi.doMock('../../backend/db', () => ({ db }));
    vi.doMock('../../backend/services/email', () => ({ sendEmail }));
    vi.doMock('../../backend/middleware/auth', () => ({
        authenticateToken: (req: any, _res: any, next: (...args: any[]) => any) => {
            req.user = { id: 'u1' };
            next();
        }
    }));

    const { default: authRouter } = await import('../../backend/routes/auth');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);

    return { app, db, sendEmail };
}

describe('Auth Router Branches', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('register rejects non-@sheffield.ac.uk email outside test env', async () => {
        const { app, db } = await loadAuthApp('production');
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, [{ id: 'basic' }]));
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null));

        const res = await request(app).post('/api/auth/register').send({
            firstName: 'Prod',
            lastName: 'User',
            email: 'person@gmail.com',
            registrationNumber: 'ABC123',
            password: 'Password123!',
            passwordConfirm: 'Password123!'
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('@sheffield.ac.uk');
    });

    it('register returns 500 when no membership types are configured', async () => {
        const { app, db } = await loadAuthApp('production');
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, []));

        const res = await request(app).post('/api/auth/register').send({
            firstName: 'Prod',
            lastName: 'User',
            email: 'person@sheffield.ac.uk',
            registrationNumber: 'ABC123',
            password: 'Password123!',
            passwordConfirm: 'Password123!'
        });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('No membership types configured');
    });

    it('login blocks unverified user outside test env', async () => {
        const { app, db } = await loadAuthApp('production');
        const passwordHash = await bcrypt.hash('Password123!', 4);
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
            cb(null, {
                id: 'u1',
                email: 'person@sheffield.ac.uk',
                passwordHash,
                emailVerified: 0
            })
        );

        const res = await request(app).post('/api/auth/login').send({
            email: 'person@sheffield.ac.uk',
            password: 'Password123!'
        });

        expect(res.status).toBe(403);
        expect(res.body.pendingVerification).toBe(true);
    });

    it('request-verification rejects already verified users', async () => {
        const { app, db } = await loadAuthApp('production');
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
            cb(null, {
                id: 'u1',
                email: 'person@sheffield.ac.uk',
                emailVerified: 1
            })
        );

        const res = await request(app).post('/api/auth/request-verification').send({ userId: 'u1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Email is already verified');
    });

    it('forgot-password still returns 200 when APP_URL is missing in production', async () => {
        const { app, db, sendEmail } = await loadAuthApp('production');
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
            cb(null, {
                id: 'u1',
                firstName: 'Reset',
                lastName: 'User',
                email: 'person@sheffield.ac.uk'
            })
        );

        const res = await request(app).post('/api/auth/forgot-password').send({
            email: 'person@sheffield.ac.uk'
        });

        expect(res.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('register returns pendingVerification in non-test env for valid sheffield emails', async () => {
        const { app, db, sendEmail } = await loadAuthApp('production');
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, [{ id: 'basic' }]));
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null));

        const res = await request(app).post('/api/auth/register').send({
            firstName: 'Prod',
            lastName: 'User',
            email: 'person@sheffield.ac.uk',
            registrationNumber: 'ABC123',
            password: 'Password123!',
            passwordConfirm: 'Password123!'
        });

        expect(res.status).toBe(200);
        expect(res.body.pendingVerification).toBe(true);
        expect(typeof res.body.userId).toBe('string');
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it('register returns 500 if OTP creation fails after user insert', async () => {
        const { app, db } = await loadAuthApp('production');
        db.all.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, [{ id: 'basic' }]));
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) => cb(null, null));
        const originalRun = db.run.getMockImplementation();
        db.run.mockImplementation((sql: string, params: any, cb?: (...args: any[]) => any) => {
            const callback = typeof params === 'function' ? params : cb;
            if (typeof sql === 'string' && sql.includes('INSERT OR REPLACE INTO email_verifications')) {
                if (callback) callback.call({ changes: 0 }, new Error('DB Error'));
                return db;
            }
            if (originalRun) return originalRun(sql, params, cb);
            if (callback) callback.call({ changes: 1 }, null);
            return db;
        });

        const res = await request(app).post('/api/auth/register').send({
            firstName: 'Prod',
            lastName: 'User',
            email: 'person2@sheffield.ac.uk',
            registrationNumber: 'ABC124',
            password: 'Password123!',
            passwordConfirm: 'Password123!'
        });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to create verification code');
    });

    it('reset-password rejects expired tokens and deletes them', async () => {
        const { app, db } = await loadAuthApp('production');
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
            cb(null, {
                token: 'tok',
                userId: 'u1',
                expiresAt: Date.now() - 1000
            })
        );
        const runSpy = vi.spyOn(db, 'run');

        const res = await request(app).post('/api/auth/reset-password').send({
            token: 'tok',
            newPassword: 'Password123!'
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid or expired reset token');
        // dbRun (promisified helper) always appends a callback to db.run
        expect(runSpy).toHaveBeenCalledWith(
            'DELETE FROM password_resets WHERE token = ?',
            ['tok'],
            expect.any(Function)
        );
    });

    it('reset-password returns 500 when password hashing throws', async () => {
        const { app, db } = await loadAuthApp('production');
        db.get.mockImplementationOnce((_sql: string, _params: any[], cb: (...args: any[]) => any) =>
            cb(null, {
                token: 'tok2',
                userId: 'u1',
                expiresAt: Date.now() + 60_000
            })
        );
        const hashSpy = vi.spyOn(bcrypt, 'hash').mockRejectedValueOnce(new Error('hash fail') as never);

        const res = await request(app).post('/api/auth/reset-password').send({
            token: 'tok2',
            newPassword: 'Password123!'
        });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Server error');
        hashSpy.mockRestore();
    });
});
