import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

/**
 * Transactional gear-flow tests: approve/return are db.serialize() blocks with
 * BEGIN/COMMIT and conditional updates. These tests prove stock is mutated
 * exactly once per transition and that conflicting transitions are rejected.
 */
describe('Gear transactions', () => {
    let adminToken = '';
    let userToken = '';
    let gearId = '';

    beforeAll(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));

        const userRes = await request(app).post('/api/auth/register').send({
            firstName: 'Tx',
            lastName: 'User',
            email: 'tx_user@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'TX1234'
        });
        userToken = userRes.body.token;

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        adminToken = adminRes.body.token;

        const gearRes = await request(app)
            .post('/api/gear')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Tx Harness ${Date.now()}`, description: 'test', totalQuantity: 2 });
        expect(gearRes.status).toBe(200);
        gearId = gearRes.body.id;
    });

    afterAll(() => {
        db.close();
    });

    const createRequest = async () => {
        const res = await request(app).post(`/api/gear/${gearId}/request`).set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(200);
        return res.body.requestId as string;
    };

    it('approve decrements stock exactly once; second approval conflicts', async () => {
        const requestId = await createRequest();

        const approved = await request(app)
            .post(`/api/gear/requests/${requestId}/approve`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(approved.status).toBe(200);

        const gearAfter = await request(app).get('/api/gear').set('Authorization', `Bearer ${adminToken}`);
        const item = gearAfter.body.find((g: any) => g.id === gearId);
        expect(item.availableQuantity).toBe(1);

        // A different user requests; approving should still find pending state fine,
        // but re-approving the SAME request must fail with "no longer pending"
        const again = await request(app)
            .post(`/api/gear/requests/${requestId}/approve`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect([400, 404]).toContain(again.status);
        if (again.status === 400) {
            expect(again.body.error).toBe('Request is not pending');
        }
    });

    it('return restores stock and rejects double-return', async () => {
        const requestId = await createRequest();
        await request(app).post(`/api/gear/requests/${requestId}/approve`).set('Authorization', `Bearer ${adminToken}`);

        const returned = await request(app)
            .post(`/api/gear/requests/${requestId}/return`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(returned.status).toBe(200);

        const gearAfter = await request(app).get('/api/gear').set('Authorization', `Bearer ${adminToken}`);
        const item = gearAfter.body.find((g: any) => g.id === gearId);
        // Ledger: totalQuantity 2 -> test 1 consumed 1 -> this test consumed 1 ->
        // this return restores exactly 1
        expect(item.availableQuantity).toBe(1);

        // Double-return must conflict
        const second = await request(app)
            .post(`/api/gear/requests/${requestId}/return`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(second.status).toBe(400);
        expect(second.body.error).toBe('Request is not approved');
    });

    it('out-of-stock gear cannot be requested', async () => {
        // Exhaust remaining stock
        const r1 = await createRequest();
        await request(app).post(`/api/gear/requests/${r1}/approve`).set('Authorization', `Bearer ${adminToken}`);

        const res = await request(app).post(`/api/gear/${gearId}/request`).set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Gear out of stock');
    });
});
