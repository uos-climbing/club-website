import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Voting API', () => {
    let userToken: string;
    let userId: string;

    beforeAll(async () => {
        // Wait for DB initialization
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Create a regular user
        const userRes = await request(app).post('/api/auth/register').send({
            firstName: 'Voting',
            lastName: 'User',
            email: 'voter@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'VOTER1'
        });
        const cookies1 = userRes.headers['set-cookie'];
        const cookieArray1 = Array.isArray(cookies1) ? cookies1 : cookies1 ? [cookies1] : [];
        const tokenCookie1 = cookieArray1.find((c: string) => c.startsWith('uscc_token='));
        userToken = tokenCookie1 ? tokenCookie1.split(';')[0].split('=')[1] : '';
        userId = userRes.body.user.id;
    });

    afterAll(async () => {
        db.close();
    });

    const createVoterUser = async (prefix: string) => {
        const ts = Date.now() + Math.floor(Math.random() * 1000);
        const email = `${prefix}${ts}_voter@example.com`;
        const userRes = await request(app)
            .post('/api/auth/register')
            .send({
                firstName: prefix + ts,
                lastName: 'Voting User',
                email,
                password: 'Password123!',
                passwordConfirm: 'Password123!',
                registrationNumber: `${prefix}${ts}VOTER`
            });
        const cookies = userRes.headers['set-cookie'];
        const cookieArray = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
        const tokenCookie = cookieArray.find((c: string) => c.startsWith('uscc_token='));
        return {
            token: tokenCookie ? tokenCookie.split(';')[0].split('=')[1] : userRes.body.token || '',
            id: userRes.body.user?.id || userRes.body.id || '',
            email
        };
    };

    it('should fail to apply when elections are closed', async () => {
        const { token } = await createVoterUser('apply_closed');
        const res = await request(app).post('/api/voting/apply').set('Authorization', `Bearer ${token}`).send({
            manifesto: 'Vote for me!',
            role: 'President'
        });

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty('error', 'Elections are not currently open');
    });

    it('should be able to see voting status', async () => {
        const { token } = await createVoterUser('status_check');
        const res = await request(app).get('/api/voting/status').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('hasVoted', false);
        expect(res.body).toHaveProperty('isCandidate', false);
        expect(res.body).toHaveProperty('electionsOpen', false);
    });

    it('should list candidates', async () => {
        const { token } = await createVoterUser('list_check');
        const res = await request(app).get('/api/voting/candidates').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('should allow application when elections are open', async () => {
        const { token } = await createVoterUser('apply_open');

        // Admin opens elections
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });

        const res = await request(app)
            .post('/api/voting/apply')
            .set('Authorization', `Bearer ${token}`)
            .send({ manifesto: 'Vote for me!', role: 'President' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should reject double application', async () => {
        const { token } = await createVoterUser('apply_double');

        // Ensure open
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });

        // First apply
        await request(app)
            .post('/api/voting/apply')
            .set('Authorization', `Bearer ${token}`)
            .send({ manifesto: 'Vote for me!', role: 'President' });

        // Second apply
        const res = await request(app)
            .post('/api/voting/apply')
            .set('Authorization', `Bearer ${token}`)
            .send({ manifesto: 'Vote for me again!', role: 'Treasurer' });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'You are already a candidate');
    });

    it('should process a valid vote', async () => {
        const voter = await createVoterUser('real_voter');
        const candidate = await createVoterUser('real_candidate');

        // Open elections
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });

        // Apply as candidate
        await request(app)
            .post('/api/voting/apply')
            .set('Authorization', `Bearer ${candidate.token}`)
            .send({ manifesto: 'A', role: 'President' });

        const res = await request(app)
            .post('/api/voting/vote')
            .set('Authorization', `Bearer ${voter.token}`)
            .send({ candidateId: candidate.id });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should reject double voting', async () => {
        const voter = await createVoterUser('double_voter');
        const candidate = await createVoterUser('double_candidate');

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });

        await request(app)
            .post('/api/voting/apply')
            .set('Authorization', `Bearer ${candidate.token}`)
            .send({ manifesto: 'A', role: 'President' });

        // First vote
        await request(app)
            .post('/api/voting/vote')
            .set('Authorization', `Bearer ${voter.token}`)
            .send({ candidateId: candidate.id });

        // Second vote
        const res = await request(app)
            .post('/api/voting/vote')
            .set('Authorization', `Bearer ${voter.token}`)
            .send({ candidateId: candidate.id });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'You have already voted');
    });

    it('should allow withdrawal of candidacy', async () => {
        const candidate = await createVoterUser('withdraw_candidate');

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });

        // Apply
        await request(app)
            .post('/api/voting/apply')
            .set('Authorization', `Bearer ${candidate.token}`)
            .send({ manifesto: 'Will withdraw', role: 'President' });

        // Withdraw
        const res = await request(app).post('/api/voting/withdraw').set('Authorization', `Bearer ${candidate.token}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify status reflects not being a candidate
        const statusRes = await request(app)
            .get('/api/voting/status')
            .set('Authorization', `Bearer ${candidate.token}`);
        expect(statusRes.body).toHaveProperty('isCandidate', false);
    });

    // --- Referendum Tests ---

    let referendumId: string;

    it('should allow committee to create a referendum', async () => {
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });

        const res = await request(app)
            .post('/api/voting/referendums')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ title: 'Increase Budget', description: 'Should we increase the social budget by 10%?' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('id');
        expect(res.body.title).toBe('Increase Budget');

        referendumId = res.body.id;
    });

    it('should allow users to fetch referendums', async () => {
        const { token } = await createVoterUser('ref_fetch_user');

        const res = await request(app).get('/api/voting/referendums').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThanOrEqual(1);
        expect(res.body[0]).toHaveProperty('id', referendumId);
        expect(res.body[0]).toHaveProperty('yesCount', 0);
    });

    it('should allow users to vote on an active referendum', async () => {
        const { token } = await createVoterUser('ref_vote_user');

        // Ensure open
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });

        const res = await request(app)
            .post(`/api/voting/referendums/${referendumId}/vote`)
            .set('Authorization', `Bearer ${token}`)
            .send({ choice: 'yes' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify vote was counted
        const getRes = await request(app).get('/api/voting/referendums').set('Authorization', `Bearer ${token}`);

        const ref = getRes.body.find((r: any) => r.id === referendumId);
        expect(ref.yesCount).toBe(1);
        expect(ref.myVote).toBe('yes');
    });

    it('should reject double voting on the same referendum', async () => {
        const { token } = await createVoterUser('ref_double_vote_user');

        await request(app)
            .post(`/api/voting/referendums/${referendumId}/vote`)
            .set('Authorization', `Bearer ${token}`)
            .send({ choice: 'no' });

        const res = await request(app)
            .post(`/api/voting/referendums/${referendumId}/vote`)
            .set('Authorization', `Bearer ${token}`)
            .send({ choice: 'yes' });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'You have already voted on this referendum');
    });

    it('should allow committee to reset elections', async () => {
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });

        const res = await request(app).post('/api/voting/reset').set('Authorization', `Bearer ${adminRes.body.token}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify everything is wiped
        const candidatesRes = await request(app)
            .get('/api/voting/candidates')
            .set('Authorization', `Bearer ${adminRes.body.token}`);
        expect(candidatesRes.body.length).toBe(0);

        const referendumsRes = await request(app)
            .get('/api/voting/referendums')
            .set('Authorization', `Bearer ${adminRes.body.token}`);
        expect(referendumsRes.body.length).toBe(0);

        const statusRes = await request(app)
            .get('/api/voting/status')
            .set('Authorization', `Bearer ${adminRes.body.token}`);
        expect(statusRes.body.electionsOpen).toBe(false);
    });

    it('should handle withdraw candidate DB errors', async () => {
        const candidate = await createVoterUser('db_withdraw');
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });
        await request(app)
            .post('/api/voting/apply')
            .set('Authorization', `Bearer ${candidate.token}`)
            .send({ manifesto: 'A', role: 'President' });

        const originalRun = db.run.bind(db);
        const spyRun = vi.spyOn(db, 'run').mockImplementation((query, params, cb) => {
            if (typeof query === 'string' && query.includes('DELETE FROM candidates WHERE userId = ?')) {
                const callback = typeof params === 'function' ? params : cb;
                if (callback) (callback as (...args: any[]) => any).call({}, new Error('DB Error'));
                return db;
            }
            return originalRun(query, params as any, cb as any);
        });

        const res = await request(app).post('/api/voting/withdraw').set('Authorization', `Bearer ${candidate.token}`);
        expect(res.status).toBe(500);
        spyRun.mockRestore();
    });

    it('should handle invalid referendum vote choice', async () => {
        const voter = await createVoterUser('ref_invalid_choice');
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });

        const refRes = await request(app)
            .post('/api/voting/referendums')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ title: 'T', description: 'D' });
        const refId = refRes.body.id;

        const res = await request(app)
            .post(`/api/voting/referendums/${refId}/vote`)
            .set('Authorization', `Bearer ${voter.token}`)
            .send({ choice: 'maybe' });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Invalid choice. Must be yes, no, or abstain.');
    });

    it('should reject referendum vote when elections are closed', async () => {
        const voter = await createVoterUser('ref_closed_vote');
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        const refRes = await request(app)
            .post('/api/voting/referendums')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ title: 'T', description: 'D' });
        const refId = refRes.body.id;

        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: false });

        const res = await request(app)
            .post(`/api/voting/referendums/${refId}/vote`)
            .set('Authorization', `Bearer ${voter.token}`)
            .send({ choice: 'yes' });

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty('error', 'Elections are not currently open');
    });

    it('should handle referendum vote DB error', async () => {
        const voter = await createVoterUser('ref_db_err');
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        await request(app)
            .post('/api/admin/config/elections')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ open: true });

        const refRes = await request(app)
            .post('/api/voting/referendums')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ title: 'T', description: 'D' });
        const refId = refRes.body.id;

        const originalRun = db.run.bind(db);
        const spyRun = vi.spyOn(db, 'run').mockImplementation((query, params, cb) => {
            if (typeof query === 'string' && query.includes('INSERT INTO referendum_votes')) {
                const callback = typeof params === 'function' ? params : cb;
                if (callback) (callback as (...args: any[]) => any).call({}, new Error('DB Error'));
                return db;
            }
            return originalRun(query, params as any, cb as any);
        });

        const res = await request(app)
            .post(`/api/voting/referendums/${refId}/vote`)
            .set('Authorization', `Bearer ${voter.token}`)
            .send({ choice: 'yes' });

        expect(res.status).toBe(500);
        spyRun.mockRestore();
    });

    it('should allow committee to delete a referendum', async () => {
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });
        const refRes = await request(app)
            .post('/api/voting/referendums')
            .set('Authorization', `Bearer ${adminRes.body.token}`)
            .send({ title: 'Delete Me', description: 'Desc' });
        const refId = refRes.body.id;

        const res = await request(app)
            .delete(`/api/voting/referendums/${refId}`)
            .set('Authorization', `Bearer ${adminRes.body.token}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify it's gone
        const listRes = await request(app)
            .get('/api/voting/referendums')
            .set('Authorization', `Bearer ${adminRes.body.token}`);
        const found = listRes.body.find((r: any) => r.id === refId);
        expect(found).toBeUndefined();
    });

    it('should handle reset rollback correctly', async () => {
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ email: 'committee@sheffieldclimbing.org', password: 'SuperSecret123!' });

        // We need to force an error in the synchronize block.
        // Since the code uses try/catch around db.run (which is async), we can mock db.run to throw synchronously.
        const originalRun = db.run.bind(db);
        const spyRun = vi.spyOn(db, 'run').mockImplementation((query, params, cb) => {
            if (typeof query === 'string' && query.includes('DELETE FROM votes')) {
                throw new Error('Sync Error');
            }
            return originalRun(query, params as any, cb as any);
        });

        const res = await request(app).post('/api/voting/reset').set('Authorization', `Bearer ${adminRes.body.token}`);
        expect(res.status).toBe(500);
        expect(res.body).toHaveProperty('error', 'Database error during reset');
        spyRun.mockRestore();
    });
});
