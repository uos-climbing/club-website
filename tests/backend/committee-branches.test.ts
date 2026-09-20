import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Committee Route Branches', () => {
    let rootToken = '';
    let committeeToken = '';

    beforeAll(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));

        const adminRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const adminCookies = adminRes.headers['set-cookie'] as unknown as string[] | undefined;
        const adminCookie = (adminCookies || []).find((c) => c.startsWith('uscc_token='));
        rootToken = adminCookie ? adminCookie.split(';')[0].split('=')[1] : '';

        const email = `committee_branches_${Date.now()}@example.com`;
        const regRes = await request(app)
            .post('/api/auth/register')
            .send({
                firstName: 'Committee',
                lastName: 'Branches',
                email,
                password: 'Password123!',
                passwordConfirm: 'Password123!',
                registrationNumber: `${Date.now()}22`
            });
        const committeeId = regRes.body.user.id;
        await request(app).post(`/api/admin/users/${committeeId}/promote`).set('Authorization', `Bearer ${rootToken}`);

        const loginRes = await request(app).post('/api/auth/login').send({
            email,
            password: 'Password123!'
        });
        const cookies = loginRes.headers['set-cookie'] as unknown as string[] | undefined;
        const cookie = (cookies || []).find((c) => c.startsWith('uscc_token='));
        committeeToken = cookie ? cookie.split(';')[0].split('=')[1] : '';
    });

    afterAll(async () => {
        db.close();
    });

    it('returns 500 when committee list query fails', async () => {
        const spy = vi
            .spyOn(db, 'all')
            .mockImplementationOnce((_sql: string, _params: any[], cb: any) => cb(new Error('DB Error'), null));
        const res = await request(app).get('/api/committee');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
        spy.mockRestore();
    });

    it('returns 500 when committee profile update DB write fails', async () => {
        const spy = vi
            .spyOn(db, 'run')
            .mockImplementationOnce((_sql: string, _params: any[], cb: any) => cb.call({}, new Error('DB Error')));
        const res = await request(app)
            .put('/api/committee/me')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({ bio: 'x' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');
        spy.mockRestore();
    });
});
