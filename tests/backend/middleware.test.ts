import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Middleware Auth API', () => {

    beforeAll(async () => {
        // Wait for DB initialization
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Create kit sec (needs promotion by admin)
        const u3 = await request(app).post('/api/auth/register').send({
            firstName: 'Kit',
            lastName: 'User',
            email: 'kit@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'KIT3'
        });
        const kitId = u3.body.user.id;

        // Login Admin
        const adminRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const adminCookies = adminRes.headers['set-cookie'];
        const adminCookieArray = Array.isArray(adminCookies) ? adminCookies : adminCookies ? [adminCookies] : [];
        const adminCookie = adminCookieArray.find((c: string) => c.startsWith('uscc_token='));
        const rootToken = adminCookie ? adminCookie.split(';')[0].split('=')[1] : '';

        // Promote Kit
        await request(app).post(`/api/admin/users/${kitId}/promote`).set('Authorization', `Bearer ${rootToken}`);
        await request(app)
            .post(`/api/admin/users/${kitId}/committee-role`)
            .set('Authorization', `Bearer ${rootToken}`)
            .send({ committeeRole: 'Kit & Safety Sec' });

    });

    afterAll(async () => {
        db.close();
    });

    const getAdminToken = async () => {
        const adminRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const adminCookies = adminRes.headers['set-cookie'];
        const adminCookieArray = Array.isArray(adminCookies) ? adminCookies : adminCookies ? [adminCookies] : [];
        const adminCookie = adminCookieArray.find((c: string) => c.startsWith('uscc_token='));
        return adminCookie ? adminCookie.split(';')[0].split('=')[1] : '';
    };

    const createRoleUser = async (roleType: 'member' | 'committee' | 'kit') => {
        const ts = Date.now();
        const base = { password: 'Password123!', passwordConfirm: 'Password123!' };

        const extractToken = (res: any) => {
            const cookies = res.headers['set-cookie'];
            const cookieArray = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
            const tc = cookieArray.find((c: string) => c.startsWith('uscc_token='));
            return tc ? tc.split(';')[0].split('=')[1] : '';
        };

        if (roleType === 'member') {
            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    ...base,
                    firstName: 'Mem',
                    lastName: 'User',
                    email: `mem${ts}@example.com`,
                    registrationNumber: `M${ts}`
                });
            return extractToken(res);
        } else if (roleType === 'committee') {
            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    ...base,
                    firstName: 'Com',
                    lastName: 'User',
                    email: `com${ts}@example.com`,
                    registrationNumber: `C${ts}`
                });
            const comId = res.body.user?.id || res.body.id || '';

            // Promote to committee via admin
            const rootToken = await getAdminToken();
            await request(app).post(`/api/admin/users/${comId}/promote`).set('Authorization', `Bearer ${rootToken}`);

            // Re-login to get a fresh JWT with the updated committee role
            const loginRes = await request(app)
                .post('/api/auth/login')
                .send({
                    email: `com${ts}@example.com`,
                    password: 'Password123!'
                });
            return extractToken(loginRes);
        } else {
            // Kit Sec
            const res = await request(app)
                .post('/api/auth/register')
                .send({
                    ...base,
                    firstName: 'Kit',
                    lastName: 'User',
                    email: `kit${ts}@example.com`,
                    registrationNumber: `K${ts}`
                });
            const kitId = res.body.user?.id || res.body.id || '';

            const rootToken = await getAdminToken();
            await request(app).post(`/api/admin/users/${kitId}/promote`).set('Authorization', `Bearer ${rootToken}`);
            await request(app)
                .post(`/api/admin/users/${kitId}/committee-role`)
                .set('Authorization', `Bearer ${rootToken}`)
                .send({ committeeRole: 'Kit & Safety Sec' });

            // Re-login to get a fresh JWT with the updated role
            const loginRes = await request(app)
                .post('/api/auth/login')
                .send({
                    email: `kit${ts}@example.com`,
                    password: 'Password123!'
                });
            return extractToken(loginRes);
        }
    };

    it('requires auth token for protected routes', async () => {
        const res = await request(app).get('/api/auth/me');
        expect(res.status).toBe(401);
    });

    it('blocks regular members from accessing admin routes', async () => {
        const memToken = await createRoleUser('member');
        const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${memToken}`);
        expect(res.status).toBe(403);
    });

    it('allows committee members to access admin routes', async () => {
        const comToken = await createRoleUser('committee');
        const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${comToken}`);
        expect(res.status).toBe(200);
    });

    it('allows a member JWT after the user is promoted', async () => {
        const timestamp = Date.now();
        const registration = await request(app)
            .post('/api/auth/register')
            .send({
                firstName: 'New',
                lastName: 'Committee',
                email: `new-committee-${timestamp}@example.com`,
                password: 'Password123!',
                passwordConfirm: 'Password123!',
                registrationNumber: `NC${timestamp}`
            });
        const userId = registration.body.user.id;
        const memberToken = registration.headers['set-cookie']
            ?.find((cookie: string) => cookie.startsWith('uscc_token='))
            ?.split(';')[0]
            .split('=')[1];
        const rootToken = await getAdminToken();

        expect((await request(app).get('/api/admin/users').set('Authorization', `Bearer ${memberToken}`)).status).toBe(
            403
        );
        await request(app).post(`/api/admin/users/${userId}/promote`).set('Authorization', `Bearer ${rootToken}`);

        expect((await request(app).get('/api/admin/users').set('Authorization', `Bearer ${memberToken}`)).status).toBe(
            200
        );
    });

    it('rejects a committee JWT after the user is demoted', async () => {
        const timestamp = Date.now();
        const registration = await request(app)
            .post('/api/auth/register')
            .send({
                firstName: 'Former',
                lastName: 'Committee',
                email: `former-committee-${timestamp}@example.com`,
                password: 'Password123!',
                passwordConfirm: 'Password123!',
                registrationNumber: `FC${timestamp}`
            });
        const userId = registration.body.user.id;
        const rootToken = await getAdminToken();

        await request(app).post(`/api/admin/users/${userId}/promote`).set('Authorization', `Bearer ${rootToken}`);
        const login = await request(app)
            .post('/api/auth/login')
            .send({ email: `former-committee-${timestamp}@example.com`, password: 'Password123!' });
        const committeeToken = login.headers['set-cookie']
            ?.find((cookie: string) => cookie.startsWith('uscc_token='))
            ?.split(';')[0]
            .split('=')[1];

        expect(
            (await request(app).get('/api/admin/users').set('Authorization', `Bearer ${committeeToken}`)).status
        ).toBe(200);
        await request(app).post(`/api/admin/users/${userId}/demote`).set('Authorization', `Bearer ${rootToken}`);

        const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${committeeToken}`);
        expect(res.status).toBe(403);
    });

    it('blocks regular committee members from creating gear', async () => {
        const comToken = await createRoleUser('committee');
        const res = await request(app)
            .post('/api/gear')
            .set('Authorization', `Bearer ${comToken}`)
            .send({ name: 'Rope' });
        expect(res.status).toBe(403);
    });

    it('allows Kit & Safety Sec to create gear', async () => {
        const kitToken = await createRoleUser('kit');
        const res = await request(app)
            .post('/api/gear')
            .set('Authorization', `Bearer ${kitToken}`)
            .send({ name: 'Rope', totalQuantity: 1, description: 'Test' });
        expect(res.status).toBe(200);
    });
});
