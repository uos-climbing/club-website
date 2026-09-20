import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

import { app } from '../../backend/server';
import { db } from '../../backend/db';
import bcrypt from 'bcrypt';

describe('Users API', () => {
    let rootToken: string;

    beforeAll(async () => {
        // Wait for DB initialization if needed
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Login as the pre-seeded root admin
        const adminRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const cookies = adminRes.headers['set-cookie'];
        const cookieArray = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
        const adminCookie = cookieArray.find((c: string) => c.startsWith('uscc_token='));
        rootToken = adminCookie ? adminCookie.split(';')[0].split('=')[1] : adminRes.body.token || '';
    });

    afterAll(async () => {
        db.close();
    });

    const createTestUser = async (prefix: string) => {
        const ts = Date.now() + Math.floor(Math.random() * 1000);
        const email = `${prefix}${ts}_user@example.com`;
        const userRes = await request(app)
            .post('/api/auth/register')
            .send({
                firstName: prefix + ts,
                lastName: 'Test User',
                email,
                password: 'Password123!',
                passwordConfirm: 'Password123!',
                registrationNumber: `${prefix}${ts} 123`
            });
        const cookies = userRes.headers['set-cookie'];
        const cookieArray = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
        const tokenCookie = cookieArray.find((c: string) => c.startsWith('uscc_token='));
        const token = tokenCookie ? tokenCookie.split(';')[0].split('=')[1] : userRes.body.token || '';
        const id = userRes.body.user?.id || userRes.body.id || '';
        return { token, id, email };
    };

    it('should submit membership renewal with multiple types', async () => {
        const { token } = await createTestUser('renewal');
        const res = await request(app)
            .post('/api/users/me/membership-renewal')
            .set('Authorization', `Bearer ${token}`)
            .send({ membershipYear: '2026/2027', membershipTypes: ['basic', 'bouldering'] });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
        expect(res.body).toHaveProperty('membershipStatus', 'pending');

        // Let's verify it created the rows
        const memsRes = await request(app).get('/api/users/me/memberships').set('Authorization', `Bearer ${token}`);

        expect(memsRes.status).toBe(200);
        expect(Array.isArray(memsRes.body)).toBe(true);
        const types = memsRes.body.map((m: any) => m.membershipType).sort();
        // Registering normally creates a row, and the renewal created two more rows
        expect(types).toContain('basic');
        expect(types).toContain('bouldering');
    });

    it('should fail renewal without membership year', async () => {
        const { token } = await createTestUser('renewal_fail');
        const res = await request(app)
            .post('/api/users/me/membership-renewal')
            .set('Authorization', `Bearer ${token}`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Missing membership year');
    });

    it('should allow requesting an additional membership type', async () => {
        const { token } = await createTestUser('add_mem');
        const res = await request(app)
            .post('/api/users/me/memberships')
            .set('Authorization', `Bearer ${token}`)
            .send({ membershipType: 'comp_team', membershipYear: '2025/2026' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        const memsRes = await request(app).get('/api/users/me/memberships').set('Authorization', `Bearer ${token}`);

        expect(memsRes.body.length).toBeGreaterThanOrEqual(2); // 'basic' from register + 'comp_team'
        const compTeam = memsRes.body.find((m: any) => m.membershipType === 'comp_team');
        expect(compTeam).toBeDefined();
        expect(compTeam.status).toBe('pending');
    });

    it('should fail requesting an invalid membership type', async () => {
        const { token } = await createTestUser('add_mem_fail');
        const res = await request(app)
            .post('/api/users/me/memberships')
            .set('Authorization', `Bearer ${token}`)
            .send({ membershipType: 'invalid_type_123', membershipYear: '2025/2026' });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Invalid membership type');
    });

    it('should allow user to request membership status review if rejected', async () => {
        const { token, id } = await createTestUser('req_membership');

        // Force the user to be 'rejected' as if an admin rejected them
        const originalRun = db.run.bind(db);
        await new Promise((resolve) => {
            db.run('UPDATE users SET membershipStatus = ? WHERE id = ?', ['rejected', id], resolve);
        });

        const res = await request(app)
            .post('/api/users/me/request-membership')
            .set('Authorization', `Bearer ${token}`)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.membershipStatus).toBe('pending');
    });

    it('should update user profile', async () => {
        const { token, id } = await createTestUser('update');
        const res = await request(app).put(`/api/users/${id}`).set('Authorization', `Bearer ${token} `).send({
            firstName: 'Updated',
            lastName: 'Name',
            emergencyContactName: 'John Doe',
            emergencyContactMobile: '01234567890',
            pronouns: 'They/Them',
            dietaryRequirements: 'Vegan'
        });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify update
        const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token} `);
        expect(meRes.body.user).toHaveProperty('firstName', 'Updated');
        expect(meRes.body.user).toHaveProperty('lastName', 'Name');
        expect(meRes.body.user).toHaveProperty('pronouns', 'They/Them');
    });

    it('should allow committee to update another user', async () => {
        const target = await createTestUser('target_update');
        const res = await request(app)
            .put(`/api/users/${target.id}`)
            .set('Authorization', `Bearer ${rootToken} `)
            .send({
                firstName: 'Committee',
                lastName: 'Updated Name'
            });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should prevent non-committee from updating another user', async () => {
        const target = await createTestUser('target_fail');
        const attacker = await createTestUser('attacker');

        const res = await request(app)
            .put(`/api/users/${target.id}`)
            .set('Authorization', `Bearer ${attacker.token} `)
            .send({
                firstName: 'Hacked',
                lastName: 'Name'
            });

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty('error', 'Unauthorized to update this user');
    });

    it('should update password with correct current password', async () => {
        const { token, email } = await createTestUser('pwd_success');
        const res = await request(app).put('/api/users/me/password').set('Authorization', `Bearer ${token} `).send({
            currentPassword: 'Password123!',
            newPassword: 'NewPassword1!'
        });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify login works with new password
        const loginRes = await request(app).post('/api/auth/login').send({
            email: email,
            password: 'NewPassword1!'
        });
        expect(loginRes.status).toBe(200);
    });

    it('should fail password update with incorrect current password', async () => {
        const { token } = await createTestUser('pwd_fail');
        const res = await request(app).put('/api/users/me/password').set('Authorization', `Bearer ${token} `).send({
            currentPassword: 'WrongPassword!',
            newPassword: 'NewPassword1!'
        });

        expect(res.status).toBe(401);
        expect(res.body).toHaveProperty('error', 'Current password is incorrect');
    });

    it('should fail password update missing fields', async () => {
        const { token } = await createTestUser('pwd_missing');
        const res = await request(app).put('/api/users/me/password').set('Authorization', `Bearer ${token} `).send({
            newPassword: 'NewPassword1!'
        });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Missing required fields');
    });

    it('should allow user to delete themselves', async () => {
        const { token, id, email } = await createTestUser('delete_self');
        const res = await request(app).delete(`/api/users/${id}`).set('Authorization', `Bearer ${token} `);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify deletion
        const loginRes = await request(app).post('/api/auth/login').send({
            email,
            password: 'Password123!',
            passwordConfirm: 'Password123!'
        });
        expect(loginRes.status).toBe(401);
    });

    it('should prevent user from deleting someone else', async () => {
        const target = await createTestUser('delete_target');
        const attacker = await createTestUser('delete_attacker');

        const res = await request(app)
            .delete(`/api/users/${target.id}`)
            .set('Authorization', `Bearer ${attacker.token} `);

        expect(res.status).toBe(403);
    });

    it('should allow committee to delete regular user', async () => {
        const target = await createTestUser('committee_delete_target');
        const res = await request(app).delete(`/api/users/${target.id}`).set('Authorization', `Bearer ${rootToken} `);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should prevent committee from deleting another committee member', async () => {
        const target = await createTestUser('committee_safe');
        // Promote target
        await request(app).post(`/api/admin/users/${target.id}/promote`).set('Authorization', `Bearer ${rootToken}`);

        const res = await request(app).delete(`/api/users/${target.id}`).set('Authorization', `Bearer ${rootToken}`);

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty('error', 'Cannot delete another committee member');
    });

    describe('Database Errors', () => {
        it('should handle renewal DB errors', async () => {
            const { token } = await createTestUser('db_renewal');
            const originalRun = db.run.bind(db);
            const spy = vi.spyOn(db, 'run').mockImplementation((query, params, cb) => {
                if (typeof query === 'string' && query.includes('UPDATE users SET membershipYear')) {
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
            const res = await request(app)
                .post('/api/users/me/membership-renewal')
                .set('Authorization', `Bearer ${token}`)
                .send({ membershipYear: '2027/2028' });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle profile update DB errors', async () => {
            const { token, id } = await createTestUser('db_update');
            const originalRun = db.run.bind(db);
            const spy = vi.spyOn(db, 'run').mockImplementation((query, params, cb) => {
                if (typeof query === 'string' && query.includes('UPDATE users SET firstName = ?')) {
                    (cb as any).call({}, new Error('DB Error'));
                    return db;
                } else {
                    return originalRun(query, params as any, cb as any);
                }
            });
            const res = await request(app)
                .put(`/api/users/${id}`)
                .set('Authorization', `Bearer ${token}`)
                .send({ name: 'A' });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle password update DB GET errors', async () => {
            const { token } = await createTestUser('db_pwd_get');
            const originalGet = db.get.bind(db);
            const spy = vi.spyOn(db, 'get').mockImplementation((query, params, cb) => {
                if (typeof query === 'string' && query.includes('SELECT passwordHash FROM users')) {
                    (cb as any)(new Error('DB Error'), null);
                    return db;
                } else {
                    return originalGet(query, params as any, cb as any);
                }
            });
            const res = await request(app)
                .put('/api/users/me/password')
                .set('Authorization', `Bearer ${token}`)
                .send({ currentPassword: '1', newPassword: '2' });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle profile get DB errors', async () => {
            const { token } = await createTestUser('db_prof_get_err');
            const originalGet = db.get.bind(db);
            const spy = vi.spyOn(db, 'get').mockImplementation((query, params, cb) => {
                if (typeof query === 'string' && query.includes('SELECT firstName, lastName, emergencyContactName')) {
                    (cb as any)(new Error('DB Error'), null);
                    return db;
                }
                return originalGet(query, params as any, cb as any);
            });
            const res = await request(app).get('/api/users/me/profile').set('Authorization', `Bearer ${token}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should return 404 for unknown user on profile get', async () => {
            const { token } = await createTestUser('db_prof_404');
            const originalGet = db.get.bind(db);
            const spy = vi.spyOn(db, 'get').mockImplementation((query, params, cb) => {
                if (typeof query === 'string' && query.includes('SELECT firstName, lastName, emergencyContactName')) {
                    (cb as any)(null, null); // Simulate user not found
                    return db;
                }
                return originalGet(query, params as any, cb as any);
            });
            const res = await request(app).get('/api/users/me/profile').set('Authorization', `Bearer ${token}`);
            expect(res.status).toBe(404);
            spy.mockRestore();
        });

        it('should handle membership upgrade DB error', async () => {
            const { token } = await createTestUser('mem_upg_err');
            const originalRun = db.run.bind(db);
            const spy = vi.spyOn(db, 'run').mockImplementation((query, params, cb) => {
                const callback = typeof params === 'function' ? params : typeof cb === 'function' ? cb : null;
                if (typeof query === 'string' && query.includes('UPDATE user_memberships SET status = ?')) {
                    if (callback) (callback as (...args: any[]) => any).call({}, new Error('DB Error'));
                    return db;
                } else if (typeof query === 'string' && query.includes('INSERT OR IGNORE INTO user_memberships')) {
                    // Simulate duplicate so it goes to UPDATE block
                    if (callback) (callback as (...args: any[]) => any).call({ changes: 0 }, null);
                    return db;
                }
                return originalRun(query, params as any, cb as any);
            });

            const res = await request(app)
                .post('/api/users/me/memberships')
                .set('Authorization', `Bearer ${token}`)
                .send({ membershipType: 'basic', membershipYear: '2025/2026' });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should insert a new pending membership row for basic if it doesnt exist on request-membership', async () => {
            const { token } = await createTestUser('req_mem_insert');
            const originalGet = db.get.bind(db);
            let insertCalled = false;

            const spyGet = vi.spyOn(db, 'get').mockImplementation((query, params, cb) => {
                if (typeof query === 'string' && query.includes('SELECT id FROM user_memberships WHERE userId = ?')) {
                    const callback = typeof params === 'function' ? params : cb;
                    if (callback) (callback as (...args: any[]) => any)(null, null);
                    return db;
                }
                return originalGet(query, params as any, cb as any);
            });
            const originalRun = db.run.bind(db);
            const spyRun = vi.spyOn(db, 'run').mockImplementation((query, params, cb) => {
                const callback = typeof params === 'function' ? params : typeof cb === 'function' ? cb : null;
                const actualParams = Array.isArray(params) ? params : [];

                if (
                    typeof query === 'string' &&
                    query.includes('INSERT INTO user_memberships') &&
                    actualParams.includes('basic')
                ) {
                    insertCalled = true;
                    if (callback) (callback as (...args: any[]) => any).call({}, null);
                    return db;
                }
                return originalRun(query, params as any, cb as any);
            });

            const res = await request(app)
                .post('/api/users/me/request-membership')
                .set('Authorization', `Bearer ${token}`);
            expect(res.status).toBe(200);

            // Wait for background queries to execute
            let attempts = 0;
            while (!insertCalled && attempts < 15) {
                await new Promise((r) => setTimeout(r, 100));
                attempts++;
            }

            expect(insertCalled).toBe(true);

            spyGet.mockRestore();
            spyRun.mockRestore();
        });
        //     const { token } = await createTestUser('db_pwd_run');
        //     const originalRun = db.run;
        //     (db as any).run = function (query: any, params: any, cb: any) {
        //         if (typeof query === 'string' && query.includes('UPDATE users SET passwordHash')) {
        //             console.log('MOCK HIT: password update');
        //             const callback = typeof params === 'function' ? params : cb;
        //             if (typeof callback === 'function') {
        //                 callback.call({ changes: 0 }, new Error('DB Error'));
        //             }
        //             return db;
        //         }
        //         return originalRun.call(db, query, params, cb);
        //     };
        //     const res = await request(app).put('/api/users/me/password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'Password123!', newPassword: 'NewPass2!' });
        //     console.log('DEBUG pwd:', res.status, res.body);
        //     expect(res.status).toBe(500);
        //     db.run = originalRun;
        // });

        // it('should handle committee delete DB GET errors', async () => {
        //     const { id } = await createTestUser('db_del_get');
        //     console.log('DEBUG del_get id:', id, 'rootToken len:', rootToken?.length);
        //     const originalGet = db.get;
        //     (db as any).get = function (query: any, params: any, cb: any) {
        //         console.log('MOCK GET called:', query?.substring?.(0, 50));
        //         if (typeof query === 'string' && query.includes('SELECT role FROM users WHERE id = ?')) {
        //             console.log('MOCK HIT: delete get');
        //             const callback = typeof params === 'function' ? params : cb;
        //             if (typeof callback === 'function') {
        //                 callback(new Error('DB Error'), null);
        //             }
        //             return db;
        //         }
        //         return originalGet.call(db, query, params, cb);
        //     };
        //     const res = await request(app).delete(`/api/users/${id}`).set('Authorization', `Bearer ${rootToken}`);
        //     console.log('DEBUG del_get:', res.status, res.body);
        //     expect(res.status).toBe(500);
        //     db.get = originalGet;
        // });

        // it('should handle user delete DB RUN errors', async () => {
        //     const { token, id } = await createTestUser('db_del_run');
        //     console.log('DEBUG del_run id:', id, 'token len:', token?.length);
        //     const originalRun = db.run;
        //     (db as any).run = function (query: any, params: any, cb: any) {
        //         if (typeof query === 'string' && query.includes('DELETE FROM users WHERE id')) {
        //             console.log('MOCK HIT: delete run');
        //             const callback = typeof params === 'function' ? params : cb;
        //             if (typeof callback === 'function') {
        //                 callback.call({ changes: 0 }, new Error('DB Error'));
        //             }
        //             return db;
        //         }
        //         return originalRun.call(db, query, params, cb);
        //     };
        //     const res = await request(app).delete(`/api/users/${id}`).set('Authorization', `Bearer ${token}`);
        //     console.log('DEBUG del_run:', res.status, res.body);
        //     expect(res.status).toBe(500);
        //     db.run = originalRun;
        // });
    });
});
