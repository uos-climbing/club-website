import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Admin API', () => {
    let rootToken: string;
    let userToken: string;
    let committeeToken: string;
    let targetUserId: string;

    beforeAll(async () => {
        // Wait for DB initialization
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Create a regular user who will be the target of admin actions
        const userRes = await request(app).post('/api/auth/register').send({
            firstName: 'Target',
            lastName: 'User',
            email: 'target@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'TGT123'
        });
        const tokenCookie1 = (userRes.headers['set-cookie'] as any)?.find((c: string) => c.startsWith('uscc_token='));
        userToken = tokenCookie1 ? tokenCookie1.split(';')[0].split('=')[1] : '';
        targetUserId = userRes.body.user?.id || '';

        // Login as the root admin
        const adminRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const cookies = adminRes.headers['set-cookie'];
        const cookieArray = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
        const adminCookie = cookieArray.find((c: string) => c.startsWith('uscc_token='));
        rootToken = adminCookie ? adminCookie.split(';')[0].split('=')[1] : adminRes.body.token || '';

        // Login as a committee member
        const committeeRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const committeeCookies = committeeRes.headers['set-cookie'];
        const committeeCookieArray = Array.isArray(committeeCookies)
            ? committeeCookies
            : committeeCookies
              ? [committeeCookies]
              : [];
        const tokenCookie2 = committeeCookieArray.find((c: string) => c.startsWith('uscc_token='));
        committeeToken = tokenCookie2 ? tokenCookie2.split(';')[0].split('=')[1] : '';
    });

    afterAll(async () => {
        db.close();
    });

    const createTargetUser = async (prefix: string) => {
        const userRes = await request(app)
            .post('/api/auth/register')
            .send({
                firstName: prefix,
                lastName: 'Target User',
                email: `${prefix}_target@example.com`,
                password: 'Password123!',
                passwordConfirm: 'Password123!',
                registrationNumber: `${prefix}123`
            });
        const cookies = userRes.headers['set-cookie'];
        const cookieArray = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
        const tokenCookie = cookieArray.find((c: string) => c.startsWith('uscc_token='));
        const token = tokenCookie ? tokenCookie.split(';')[0].split('=')[1] : userRes.body.token || '';
        const id = userRes.body.user?.id || userRes.body.id || '';
        return { token, id };
    };

    it('should list all users for committee', async () => {
        const { id } = await createTargetUser('list');
        const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${rootToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some((u: any) => u.id === id)).toBe(true);
    });

    it('should allow committee to approve user', async () => {
        const { id } = await createTargetUser('approve');
        const res = await request(app)
            .post(`/api/admin/users/${id}/approve`)
            .set('Authorization', `Bearer ${rootToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should allow root admin to assign committee roles', async () => {
        const { id } = await createTargetUser('assign_role');
        const res = await request(app)
            .post(`/api/admin/users/${id}/committee-role`)
            .set('Authorization', `Bearer ${rootToken}`)
            .send({ committeeRoles: ['Treasurer'] });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should fail to assign invalid committee role', async () => {
        const { id } = await createTargetUser('invalid_role');
        const res = await request(app)
            .post(`/api/admin/users/${id}/committee-role`)
            .set('Authorization', `Bearer ${rootToken}`)
            .send({ committeeRoles: ['Emperor'] });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Invalid committee role');
    });

    it('should allow assigning multiple committee roles', async () => {
        const { id } = await createTargetUser('multi_role');
        const res = await request(app)
            .post(`/api/admin/users/${id}/committee-role`)
            .set('Authorization', `Bearer ${rootToken}`)
            .send({ committeeRoles: ['Chair', 'Treasurer'] });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify both roles are returned in GET /api/admin/users
        const usersRes = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${rootToken}`);
        const member = usersRes.body.find((u: any) => u.id === id);
        expect(member).toBeDefined();
        expect(member.committeeRoles).toContain('Chair');
        expect(member.committeeRoles).toContain('Treasurer');
    });

    it('should allow committee to reject user', async () => {
        const { id } = await createTargetUser('reject');
        const res = await request(app)
            .post(`/api/admin/users/${id}/reject`)
            .set('Authorization', `Bearer ${rootToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should allow root admin to demote a user', async () => {
        const { id } = await createTargetUser('demote');
        await request(app).post(`/api/admin/users/${id}/promote`).set('Authorization', `Bearer ${rootToken}`);

        const res = await request(app)
            .post(`/api/admin/users/${id}/demote`)
            .set('Authorization', `Bearer ${rootToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should prevent non-root committee users from promoting members', async () => {
        const { id: committeeId } = await createTargetUser('non_root_promoter');
        await request(app).post(`/api/admin/users/${committeeId}/promote`).set('Authorization', `Bearer ${rootToken}`);
        const committeeLogin = await request(app).post('/api/auth/login').send({
            email: 'non_root_promoter_target@example.com',
            password: 'Password123!'
        });
        const committeeToken = committeeLogin.headers['set-cookie']
            ?.find((cookie: string) => cookie.startsWith('uscc_token='))
            ?.split(';')[0]
            .split('=')[1];
        const { id: targetId } = await createTargetUser('promotion_target');

        const res = await request(app)
            .post(`/api/admin/users/${targetId}/promote`)
            .set('Authorization', `Bearer ${committeeToken}`);

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty('error', 'Only Root Admin can perform this action');
    });

    it('should prevent non-root admin from demoting', async () => {
        const { id } = await createTargetUser('non_root_demote');
        // userToken was created in beforeAll
        const res = await request(app)
            .post(`/api/admin/users/${id}/demote`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(403);
    });

    it('should fail if unauthorized user tries to access admin routes', async () => {
        const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(403);
    });

    it('should toggle election config', async () => {
        const resOn = await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${rootToken}`)
            .send({ open: true });
        expect(resOn.status).toBe(200);

        const resGet = await request(app)
            .get('/api/admin/config/elections')
            .set('Authorization', `Bearer ${rootToken}`);
        expect(resGet.body).toHaveProperty('electionsOpen', true);
    });

    it('should allow root admin to trigger a test email', async () => {
        const res = await request(app).post('/api/admin/test-email').set('Authorization', `Bearer ${rootToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
        expect(res.body).toHaveProperty('target', 'committee@sheffieldclimbing.org');
        expect(typeof res.body.sent).toBe('boolean');
    });

    it('should prevent non-root committee users from triggering test email', async () => {
        const nonRootRes = await request(app).post('/api/auth/register').send({
            firstName: 'Non',
            lastName: 'Root',
            email: 'non_root_admin@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'NRAD1'
        });
        const nonRootId = nonRootRes.body.user?.id;
        await request(app).post(`/api/admin/users/${nonRootId}/promote`).set('Authorization', `Bearer ${rootToken}`);
        const reloginRes = await request(app).post('/api/auth/login').send({
            email: 'non_root_admin@example.com',
            password: 'Password123!'
        });
        const reloginCookie = (reloginRes.headers['set-cookie'] as any)?.find((c: string) =>
            c.startsWith('uscc_token=')
        );
        const nonRootCommitteeToken = reloginCookie ? reloginCookie.split(';')[0].split('=')[1] : '';

        const res = await request(app)
            .post('/api/admin/test-email')
            .set('Authorization', `Bearer ${nonRootCommitteeToken}`);

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty('error', 'Only Root Admin can perform this action');
    });

    it('should reject invalid committee role', async () => {
        const targetRes = await request(app).post('/api/auth/register').send({
            firstName: 'Role',
            lastName: 'Test',
            email: 'role@example.com',
            password: 'Password12345!',
            passwordConfirm: 'Password12345!',
            registrationNumber: 'R1'
        });
        const res = await request(app)
            .post(`/api/admin/users/${targetRes.body.user.id}/committee-role`)
            .set('Authorization', `Bearer ${rootToken}`)
            .send({ committeeRole: 'Fake Role' });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Invalid committee role');
    });

    it('should clear committee role if none provided', async () => {
        const targetRes = await request(app).post('/api/auth/register').send({
            firstName: 'Role',
            lastName: 'Clear',
            email: 'clear@example.com',
            password: 'Password12345!',
            passwordConfirm: 'Password12345!',
            registrationNumber: 'RC1'
        });
        const res = await request(app)
            .post(`/api/admin/users/${targetRes.body.user.id}/committee-role`)
            .set('Authorization', `Bearer ${rootToken}`)
            .send({ committeeRoles: [] });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    describe('Database Errors', () => {
        it('should handle config DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app)
                .get('/api/admin/config/elections')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle config update DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/admin/config/elections')
                .set('Authorization', `Bearer ${rootToken}`)
                .send({ open: true });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle users GET DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'all')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle user approve DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/admin/users/1/approve')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle user reject DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/admin/users/1/reject')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle user promote DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/admin/users/1/promote')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle user demote DB GET errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app)
                .post('/api/admin/users/1/demote')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle user demote DB RUN errors', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(null, { email: 'user@test.com' }));
            const spyRun = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/admin/users/1/demote')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spyGet.mockRestore();
            spyRun.mockRestore();
        });

        it('should handle committee role DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/admin/users/1/committee-role')
                .set('Authorization', `Bearer ${rootToken}`)
                .send({ committeeRole: 'Chair' });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });
    });

    describe('Membership Row Management', () => {
        it('should allow committee to approve a membership row', async () => {
            const { id } = await createTargetUser('appr_memb');
            await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${rootToken}`);
            await new Promise((r) => setTimeout(r, 50)); // Wait for background insert

            const usersRes = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${rootToken}`);
            const member = usersRes.body.find((u: any) => u.id === id);
            const membId = member?.memberships?.[0]?.id;

            // Reject first to reset it
            await request(app)
                .post(`/api/admin/memberships/${membId}/reject`)
                .set('Authorization', `Bearer ${rootToken}`);

            const res = await request(app)
                .post(`/api/admin/memberships/${membId}/approve`)
                .set('Authorization', `Bearer ${rootToken}`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('success', true);
        });

        it('should allow committee to reject a membership row', async () => {
            const { id } = await createTargetUser('rej_memb');
            await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${rootToken}`);
            await new Promise((r) => setTimeout(r, 50)); // Wait for background insert

            const usersRes = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${rootToken}`);
            const member = usersRes.body.find((u: any) => u.id === id);
            const membId = member?.memberships?.[0]?.id;

            const res = await request(app)
                .post(`/api/admin/memberships/${membId}/reject`)
                .set('Authorization', `Bearer ${rootToken}`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('success', true);
        });

        it('should return 404 for unknown membership row on approve', async () => {
            const res = await request(app)
                .post('/api/admin/memberships/nonexistent/approve')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(404);
        });

        it('should return 404 for unknown membership row on reject', async () => {
            const res = await request(app)
                .post('/api/admin/memberships/nonexistent/reject')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(404);
        });

        it('should handle DB errors on membership approve', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) =>
                    cb(null, { id: 'any', userId: 'usr', membershipType: 'basic' })
                );
            const spyRun = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/admin/memberships/any/approve')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spyGet.mockRestore();
            spyRun.mockRestore();
        });

        it('should handle DB errors on membership reject', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) =>
                    cb(null, { id: 'any', userId: 'usr', membershipType: 'basic' })
                );
            const spyRun = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .post('/api/admin/memberships/any/reject')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spyGet.mockRestore();
            spyRun.mockRestore();
        });

        it('should handle DB GET errors on membership approve', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app)
                .post('/api/admin/memberships/any/approve')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spyGet.mockRestore();
        });

        it('should handle DB GET errors on membership reject', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app)
                .post('/api/admin/memberships/any/reject')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spyGet.mockRestore();
        });

        it('should allow committee to delete a membership row', async () => {
            // Create a user and approve their basic membership
            const { id } = await createTargetUser('del_memb');
            await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${rootToken}`);
            await new Promise((r) => setTimeout(r, 50)); // Wait for background insert

            // Get the membership row id
            const usersRes = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${rootToken}`);
            const member = usersRes.body.find((u: any) => u.id === id);
            const membId = member?.memberships?.[0]?.id;
            expect(membId).toBeDefined();

            const res = await request(app)
                .delete(`/api/admin/memberships/${membId}`)
                .set('Authorization', `Bearer ${rootToken}`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('success', true);
        });

        it('should return 404 for unknown membership row', async () => {
            const res = await request(app)
                .delete('/api/admin/memberships/nonexistent_id')
                .set('Authorization', `Bearer ${rootToken}`);

            expect(res.status).toBe(404);
        });

        it('should handle DB errors on membership delete', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app)
                .delete('/api/admin/memberships/any_id')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle DB run errors on membership delete', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) =>
                    cb(null, { id: 'any_id', userId: 'user', membershipType: 'basic' })
                );
            const spyRun = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .delete('/api/admin/memberships/any_id')
                .set('Authorization', `Bearer ${rootToken}`);
            expect(res.status).toBe(500);
            spyGet.mockRestore();
            spyRun.mockRestore();
        });
    });

    describe('Admin Edge Cases', () => {
        it('should prevent demoting the root admin', async () => {
            // Get root admin ID
            const usersRes = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${rootToken}`);
            const rootAdmin = usersRes.body.find((u: any) => u.email === 'committee@sheffieldclimbing.org');
            const res = await request(app)
                .post(`/api/admin/users/${rootAdmin.id}/demote`)
                .set('Authorization', `Bearer ${rootToken}`);

            expect(res.status).toBe(403);
            expect(res.body).toHaveProperty('error', 'Cannot demote the Root Admin');
        });

        it('should update existing membership row when re-approving a user', async () => {
            const { id } = await createTargetUser('reapprove');
            // First approval creates the row
            await request(app).post(`/api/admin/users/${id}/approve`).set('Authorization', `Bearer ${rootToken}`);
            await new Promise((r) => setTimeout(r, 50)); // Wait for background insert
            // Second approval updates the row
            const res = await request(app)
                .post(`/api/admin/users/${id}/approve`)
                .set('Authorization', `Bearer ${rootToken}`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('success', true);
        });
    });

    describe('Non-Root Committee Visibility', () => {
        let nonRootToken: string;

        beforeAll(async () => {
            const res = await request(app).post('/api/auth/register').send({
                firstName: 'Non',
                lastName: 'Root',
                email: 'roster_test@example.com',
                password: 'Password12345!',
                passwordConfirm: 'Password12345!',
                registrationNumber: 'RT1'
            });
            const userId = res.body.user.id;
            // Only assign role, don't "promote" to committee role='committee' to test fallback
            await request(app)
                .post(`/api/admin/users/${userId}/committee-role`)
                .set('Authorization', `Bearer ${rootToken}`)
                .send({ committeeRoles: ['Secretary'] });

            const loginRes = await request(app).post('/api/auth/login').send({
                email: 'roster_test@example.com',
                password: 'Password12345!'
            });
            const cookies = loginRes.headers['set-cookie'] as unknown as string[] | undefined;
            const cookie = (cookies || []).find((c) => c.startsWith('uscc_token='));
            nonRootToken = cookie ? cookie.split(';')[0].split('=')[1] : '';
        });

        it('should allow non-root committee member to access user roster via DB fallback', async () => {
            const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${nonRootToken}`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });

        it('should include committee roles in the fetched roster for non-root members', async () => {
            const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${nonRootToken}`);

            const me = res.body.find((u: any) => u.email === 'roster_test@example.com');
            expect(me.committeeRoles).toContain('Secretary');
        });
    });
});
