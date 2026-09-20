import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Admin audit trail', () => {
    let rootToken = '';
    let userToken = '';
    let targetUserId = '';

    beforeAll(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));

        const userRes = await request(app)
            .post('/api/auth/register')
            .send({
                firstName: 'Audit',
                lastName: 'Target',
                email: `audit_target_${Date.now()}@example.com`,
                password: 'Password123!',
                passwordConfirm: 'Password123!',
                registrationNumber: 'AUD001'
            });
        targetUserId = userRes.body.userId ?? userRes.body.user?.id;

        // Register the regular member token via a dedicated account
        const memberRes = await request(app)
            .post('/api/auth/register')
            .send({
                firstName: 'Plain',
                lastName: 'Member',
                email: `audit_member_${Date.now()}@example.com`,
                password: 'Password123!',
                passwordConfirm: 'Password123!',
                registrationNumber: 'AUD002'
            });
        userToken = memberRes.body.token;

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        rootToken = adminRes.body.token;

        // Trigger an audited action so there is at least one entry
        if (targetUserId) {
            await request(app)
                .post(`/api/admin/users/${targetUserId}/approve`)
                .set('Authorization', `Bearer ${rootToken}`);
        }
    }, 20000);

    afterAll(() => {
        db.close();
    });

    it('records approve actions with actor identity and timestamp', async () => {
        const res = await request(app).get('/api/admin/audit-log?limit=10').set('Authorization', `Bearer ${rootToken}`);
        expect(res.status).toBe(200);
        const entry = res.body.find((e: any) => e.action === 'member.approve');
        expect(entry).toBeDefined();
        expect(entry.actorId).toBe('user_root');
        expect(typeof entry.createdAt).toBe('number');
    });

    it('returns entries newest-first', async () => {
        const res = await request(app).get('/api/admin/audit-log?limit=50').set('Authorization', `Bearer ${rootToken}`);
        const times = res.body.map((e: any) => e.createdAt);
        const sorted = [...times].sort((a: number, b: number) => b - a);
        expect(times).toEqual(sorted);
    });

    it('blocks non-committee members from reading the trail', async () => {
        const res = await request(app).get('/api/admin/audit-log').set('Authorization', `Bearer ${userToken}`);
        expect([401, 403]).toContain(res.status);
    });

    it('rejects unauthenticated reads entirely', async () => {
        const res = await request(app).get('/api/admin/audit-log');
        expect(res.status).toBe(401);
    });
});
