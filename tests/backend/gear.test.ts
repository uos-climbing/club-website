import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Gear API', () => {
    let userToken: string;
    let adminToken: string;

    beforeAll(async () => {
        // Wait for DB initialization
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Create a regular user
        const userRes = await request(app).post('/api/auth/register').send({
            firstName: 'Gear',
            lastName: 'User',
            email: 'gear_user@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'GEAR123'
        });
        const tokenCookie1 = (userRes.headers['set-cookie'] as any)?.find((c: string) => c.startsWith('uscc_token='));
        userToken = tokenCookie1 ? tokenCookie1.split(';')[0].split('=')[1] : userRes.body.token || '';

        // Login as the root admin (pre-seeded in db.ts)
        const adminRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const cookies = adminRes.headers['set-cookie'];
        const cookieArray = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
        const adminCookie = cookieArray.find((c: string) => c.startsWith('uscc_token='));
        adminToken = adminCookie ? adminCookie.split(';')[0].split('=')[1] : adminRes.body.token || '';
    });

    afterAll(async () => {
        db.close();
    });

    // Helper to create a gear item
    const createGear = async (token: string, name: string) => {
        const res = await request(app).post('/api/gear').set('Authorization', `Bearer ${token}`).send({
            name,
            description: 'Desc',
            totalQuantity: 2
        });
        return res.body.id;
    };

    it('should allow admin to create gear', async () => {
        const res = await request(app).post('/api/gear').set('Authorization', `Bearer ${adminToken}`).send({
            name: 'Test Rope',
            description: '60m Lead Rope',
            totalQuantity: 2
        });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('id');
    });

    it('should list gear', async () => {
        const gearId = await createGear(adminToken, 'Listable Gear');
        const res = await request(app).get('/api/gear').set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some((g: any) => g.id === gearId)).toBe(true);
    });

    it('should allow user to request gear', async () => {
        const gearId = await createGear(adminToken, 'Requestable Gear');
        const res = await request(app).post(`/api/gear/${gearId}/request`).set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
        expect(res.body).toHaveProperty('requestId');
    });

    it('should allow admin to approve gear request', async () => {
        const gearId = await createGear(adminToken, 'Approvable Gear');

        // Setup user request
        const reqRes = await request(app)
            .post(`/api/gear/${gearId}/request`)
            .set('Authorization', `Bearer ${userToken}`);
        const requestId = reqRes.body.requestId;

        const res = await request(app)
            .post(`/api/gear/requests/${requestId}/approve`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should show user gear requests', async () => {
        const gearId = await createGear(adminToken, 'User Req Gear');

        // Setup user request
        const reqRes = await request(app)
            .post(`/api/gear/${gearId}/request`)
            .set('Authorization', `Bearer ${userToken}`);
        const requestId = reqRes.body.requestId;

        // Setup admin approval
        await request(app).post(`/api/gear/requests/${requestId}/approve`).set('Authorization', `Bearer ${adminToken}`);

        const res = await request(app).get('/api/gear/me/requests').set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body.some((r: any) => r.id === requestId)).toBe(true);
        expect(res.body.find((r: any) => r.id === requestId)).toHaveProperty('status', 'approved');
    });

    it('should allow admin to update gear', async () => {
        const gearId = await createGear(adminToken, 'Updateable Gear');
        const res = await request(app).put(`/api/gear/${gearId}`).set('Authorization', `Bearer ${adminToken}`).send({
            name: 'Updated Gear',
            description: 'Updated Desc',
            totalQuantity: 5,
            availableQuantity: 5
        });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should allow admin to delete gear', async () => {
        const gearId = await createGear(adminToken, 'Deletable Gear');
        const res = await request(app).delete(`/api/gear/${gearId}`).set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should prevent requesting out of stock gear', async () => {
        const gearId = await createGear(adminToken, 'Out of Stock Gear');

        // Admin updates it to 0 available
        await request(app).put(`/api/gear/${gearId}`).set('Authorization', `Bearer ${adminToken}`).send({
            name: 'Out of Stock Gear',
            description: 'Desc',
            totalQuantity: 2,
            availableQuantity: 0
        });

        // User tries to request
        const res = await request(app).post(`/api/gear/${gearId}/request`).set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Gear out of stock');
    });

    it('should allow admin to reject gear request', async () => {
        const gearId = await createGear(adminToken, 'Rejectable Gear');

        const reqRes = await request(app)
            .post(`/api/gear/${gearId}/request`)
            .set('Authorization', `Bearer ${userToken}`);
        const requestId = reqRes.body.requestId;

        const res = await request(app)
            .post(`/api/gear/requests/${requestId}/reject`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should allow admin to mark gear as returned', async () => {
        const gearId = await createGear(adminToken, 'Returnable Gear');

        const reqRes = await request(app)
            .post(`/api/gear/${gearId}/request`)
            .set('Authorization', `Bearer ${userToken}`);
        const requestId = reqRes.body.requestId;

        await request(app).post(`/api/gear/requests/${requestId}/approve`).set('Authorization', `Bearer ${adminToken}`);

        const res = await request(app)
            .post(`/api/gear/requests/${requestId}/return`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should view all requests as Kit Sec', async () => {
        const res = await request(app).get('/api/gear/requests').set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('should let user view their own requests', async () => {
        const res = await request(app).get('/api/gear/me/requests').set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    describe('Database Errors', () => {
        it('should handle list gear DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'all')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app).get('/api/gear').set('Authorization', `Bearer ${userToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle list all requests DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'all')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app).get('/api/gear/requests').set('Authorization', `Bearer ${adminToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle list my requests DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'all')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app).get('/api/gear/me/requests').set('Authorization', `Bearer ${userToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle create gear DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/gear')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'E' });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle update gear DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .put('/api/gear/1')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ name: 'E' });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle delete gear DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app).delete('/api/gear/1').set('Authorization', `Bearer ${adminToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle create request DB errors (GET)', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app).post('/api/gear/1/request').set('Authorization', `Bearer ${userToken}`);
            expect(res.status).toBe(404);
            spy.mockRestore();
        });

        it('should handle reject request DB errors', async () => {
            const { vi } = await import('vitest');
            const originalRun = db.run.bind(db);
            // Mock run instead of get, but only for the actual update
            const spyRun = vi.spyOn(db, 'run').mockImplementation((query, params, cb) => {
                if (typeof query === 'string' && query.includes('UPDATE gear_requests')) {
                    if (typeof params === 'function') {
                        (params as any).call({}, new Error('DB Error'));
                    } else if (typeof cb === 'function') {
                        (cb as any).call({}, new Error('DB Error'));
                    }
                    return db;
                } else {
                    return originalRun(query, params as any, cb as any);
                }
            });
            await request(app)
                .post('/api/gear/requests/1/reject')
                .set('Authorization', `Bearer ${adminToken}`);
            // Wait, if I mockImplementationOnce, it might catch a background run?
            // Let's use mockImplementation and check query, then restore.
            spyRun.mockRestore();

            const spy = vi.spyOn(db, 'get').mockImplementation((query, params, cb) => {
                if (typeof query === 'string' && query.includes('FROM gear_requests')) {
                    cb(null, { status: 'pending', email: 't@t.com', name: 'T' });
                } else if (typeof query === 'string' && query.includes('FROM users')) {
                    cb(null, { email: 'committee@sheffieldclimbing.org', committeeRole: 'Kit & Safety Sec' });
                }
            });
            const spyRun2 = vi.spyOn(db, 'run').mockImplementationOnce((query, params, cb) => {
                cb.call({}, new Error('DB Error'));
                return db;
            });

            const res2 = await request(app)
                .post('/api/gear/requests/1/reject')
                .set('Authorization', `Bearer ${adminToken}`);
            expect(res2.status).toBe(500);

            spy.mockRestore();
            spyRun2.mockRestore();
        });
    });
});
