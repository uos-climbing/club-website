import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Committee API', () => {
    let rootToken: string;
    let committeeToken: string;
    let committeeId: string;
    let memberToken: string;

    beforeAll(async () => {
        // Wait for DB
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Login as root
        const adminRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const cookies = adminRes.headers['set-cookie'];
        const cookieArray = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
        const adminCookie = cookieArray.find((c: string) => c.startsWith('uscc_token='));
        rootToken = adminCookie ? adminCookie.split(';')[0].split('=')[1] : '';

        // Create a committee user
        const commEmail = `comm_${Date.now()}@example.com`;
        const regRes = await request(app).post('/api/auth/register').send({
            firstName: 'Comm',
            lastName: 'User',
            email: commEmail,
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'COMM123'
        });
        committeeId = regRes.body.user.id;

        // Promote to committee
        await request(app).post(`/api/admin/users/${committeeId}/promote`).set('Authorization', `Bearer ${rootToken}`);

        // Assign a role
        await request(app)
            .post(`/api/admin/users/${committeeId}/committee-role`)
            .set('Authorization', `Bearer ${rootToken}`)
            .send({
                committeeRoles: ['Social Sec']
            });

        const loginRes = await request(app).post('/api/auth/login').send({
            email: commEmail,
            password: 'Password123!'
        });
        const commCookies = loginRes.headers['set-cookie'];
        const commCookieArray = Array.isArray(commCookies) ? commCookies : commCookies ? [commCookies] : [];
        const commCookie = commCookieArray.find((c: string) => c.startsWith('uscc_token='));
        committeeToken = commCookie ? commCookie.split(';')[0].split('=')[1] : '';

        // Create a regular member
        const memEmail = `mem_${Date.now()}@example.com`;
        const memRegRes = await request(app).post('/api/auth/register').send({
            firstName: 'Mem',
            lastName: 'User',
            email: memEmail,
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'MEM123'
        });
        const memCookies = memRegRes.headers['set-cookie'];
        const memCookieArray = Array.isArray(memCookies) ? memCookies : memCookies ? [memCookies] : [];
        const memCookie = memCookieArray.find((c: string) => c.startsWith('uscc_token='));
        memberToken = memCookie ? memCookie.split(';')[0].split('=')[1] : '';
    });

    afterAll(async () => {
        db.close();
    });

    it('should fetch all committee members', async () => {
        const res = await request(app).get('/api/committee');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(2); // root + our test comm
        const root = res.body.find((u: any) => u.id === 'user_root');
        expect(root).toBeDefined();
        // This is a PUBLIC endpoint (feeds the about page) — sensitive fields must be hidden
        expect(root).not.toHaveProperty('passwordHash');
        expect(root).not.toHaveProperty('email');
    });

    it('should allow committee member to update their own profile', async () => {
        const res = await request(app).put('/api/committee/me').set('Authorization', `Bearer ${committeeToken}`).send({
            instagram: 'test_insta',
            faveCrag: 'Stanage Popular',
            bio: 'Love crimps and cracks.'
        });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify in DB
        const checkRes = await request(app).get('/api/committee');
        const me = checkRes.body.find((u: any) => u.firstName === 'Comm');
        expect(me.instagram).toBe('test_insta');
        expect(me.faveCrag).toBe('Stanage Popular');
        expect(me.bio).toBe('Love crimps and cracks.');
    });

    it('should prevent regular member from updating committee profile', async () => {
        const res = await request(app)
            .put('/api/committee/me')
            .set('Authorization', `Bearer ${memberToken}`)
            .send({ bio: 'I am an impostor' });

        expect(res.status).toBe(403);
    });

    it('should export members with verified membership type as CSV', async () => {
        // Create test users with verified memberships
        const user1Email = `csv_test_user1_${Date.now()}@example.com`;
        const user2Email = `csv_test_user2_${Date.now()}@example.com`;

        // Register users
        const user1Res = await request(app).post('/api/auth/register').send({
            firstName: 'CSV',
            lastName: 'User1',
            email: user1Email,
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'CSV001'
        });
        const user1Id = user1Res.body.user.id;

        const user2Res = await request(app).post('/api/auth/register').send({
            firstName: 'CSV',
            lastName: 'User2',
            email: user2Email,
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'CSV002'
        });
        const user2Id = user2Res.body.user.id;

        // Add verified memberships
        db.run(
            'INSERT INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
            [`mem_1_${Date.now()}`, user1Id, 'basic', 'active', '2024'],
            (err) => {
                if (err) console.error('Error inserting user1 membership:', err);
            }
        );
        db.run(
            'INSERT INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
            [`mem_2_${Date.now()}`, user2Id, 'basic', 'active', '2024'],
            (err) => {
                if (err) console.error('Error inserting user2 membership:', err);
            }
        );

        // Wait a moment for DB writes
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Request CSV export
        const res = await request(app)
            .get('/api/committee/export/members?membershipType=basic')
            .set('Authorization', `Bearer ${committeeToken}`);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(res.headers['content-disposition']).toContain('attachment; filename="members-basic-');
        expect(res.text).toContain('firstName,lastName,email');
        expect(res.text).toContain('CSV');
        expect(res.text).toContain('User1');
        expect(res.text).toContain('User2');
    });

    it('should return error when membershipType parameter is missing', async () => {
        const res = await request(app)
            .get('/api/committee/export/members')
            .set('Authorization', `Bearer ${committeeToken}`);

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'membershipType query parameter is required');
    });

    it('should prevent non-committee members from exporting members', async () => {
        const res = await request(app)
            .get('/api/committee/export/members?membershipType=basic')
            .set('Authorization', `Bearer ${memberToken}`);

        expect(res.status).toBe(403);
    });

    it('should return CSV with headers even if no members match', async () => {
        const res = await request(app)
            .get('/api/committee/export/members?membershipType=nonexistent')
            .set('Authorization', `Bearer ${committeeToken}`);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/csv');
        // Should have header row but no data rows
        expect(res.text).toContain('firstName,lastName,email');
    });
});
