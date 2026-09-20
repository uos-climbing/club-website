import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';
import jwt from 'jsonwebtoken';

describe('Beta Gate Middleware & API', () => {
    const originalEnv = process.env;
    const BETA_SECRET = 'test_beta_secret';
    const PASSCODE = '1234';

    beforeAll(async () => {
        // Wait for DB initialization
        await new Promise((resolve) => setTimeout(resolve, 500));
        process.env = { ...originalEnv, IS_BETA: 'true', BETA_ACCESS_SECRET: BETA_SECRET, BETA_PASSCODE: PASSCODE };
    });

    afterAll(async () => {
        process.env = originalEnv;
        db.close();
    });

    it('allows access to public paths without a token', async () => {
        const res = await request(app).get('/beta-gate');
        // If it's the gate page, it should return 200 or 304, not redirect back to itself
        expect(res.status).not.toBe(302);
    });

    it('redirects to /beta-gate when no token is present on protected route', async () => {
        const res = await request(app).get('/dashboard.html');
        expect(res.status).toBe(302);
        expect(res.header.location).toBe('/beta-gate');
    });

    it('redirects to /beta-gate when an invalid token is present', async () => {
        const res = await request(app).get('/dashboard.html').set('Cookie', [`BETA_ACCESS_TOKEN=invalid-token`]);
        expect(res.status).toBe(302);
        expect(res.header.location).toBe('/beta-gate');
    });

    it('allows access with a valid token', async () => {
        const token = jwt.sign({ access: true }, BETA_SECRET);
        const res = await request(app)
            .get('/api/auth/me') // Use an API route to avoid SPA history fallback in tests
            .set('Cookie', [`BETA_ACCESS_TOKEN=${token}`]);

        // Should not be a 302 redirect to beta-gate
        expect(res.status).not.toBe(302);
    });

    it('fails beta authentication with wrong passcode', async () => {
        const res = await request(app).post('/api/beta-auth').send({ passcode: 'wrong' });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('succeeds beta authentication with correct passcode', async () => {
        const res = await request(app).post('/api/beta-auth').send({ passcode: PASSCODE });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.header['set-cookie']).toBeDefined();
        expect(res.header['set-cookie'][0]).toContain('BETA_ACCESS_TOKEN');
    });

    it('returns 500 if BETA_PASSCODE is not configured', async () => {
        const oldPasscode = process.env.BETA_PASSCODE;
        delete process.env.BETA_PASSCODE;
        const res = await request(app).post('/api/beta-auth').send({ passcode: PASSCODE });
        expect(res.status).toBe(500);
        expect(res.body.message).toContain('not configured');
        process.env.BETA_PASSCODE = oldPasscode;
    });

    it('passes through when IS_BETA is not true', async () => {
        process.env.IS_BETA = 'false';
        const res = await request(app).get('/dashboard.html');
        // Should not redirect
        expect(res.status).not.toBe(302);
        process.env.IS_BETA = 'true';
    });
});
