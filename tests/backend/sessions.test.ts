import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Sessions API', () => {
    let userToken: string;
    let committeeToken: string;

    beforeAll(async () => {
        // Wait for DB initialization
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Create a regular user
        const userRes = await request(app).post('/api/auth/register').send({
            firstName: 'Regular',
            lastName: 'User',
            email: 'user@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'REG123'
        });
        const tokenCookie1 = (userRes.headers['set-cookie'] as any)?.find((c: string) => c.startsWith('uscc_token='));
        userToken = tokenCookie1 ? tokenCookie1.split(';')[0].split('=')[1] : userRes.body.token || '';

        // Create a committee user (promoted by root admin)
        const committeeRes = await request(app).post('/api/auth/register').send({
            firstName: 'Committee',
            lastName: 'User',
            email: 'committee_sessions@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'ADM123'
        });
        const tokenCookie2 = (committeeRes.headers['set-cookie'] as any)?.find((c: string) =>
            c.startsWith('uscc_token=')
        );
        committeeToken = tokenCookie2 ? tokenCookie2.split(';')[0].split('=')[1] : committeeRes.body.token || '';
        const committeeUserId = committeeRes.body.user?.id || '';

        // Promote via root admin
        const adminLoginRes = await request(app).post('/api/auth/login').send({
            email: 'committee@sheffieldclimbing.org',
            password: 'SuperSecret123!'
        });
        const adminCookies = adminLoginRes.headers['set-cookie'];
        const adminCookieArray = Array.isArray(adminCookies) ? adminCookies : adminCookies ? [adminCookies] : [];
        const adminCookie = adminCookieArray.find((c: string) => c.startsWith('uscc_token='));
        const adminToken = adminCookie ? adminCookie.split(';')[0].split('=')[1] : '';
        await request(app)
            .post(`/api/admin/users/${committeeUserId}/promote`)
            .set('Authorization', `Bearer ${adminToken}`);

        // Re-login to get a fresh JWT with the updated committee role
        const refreshRes = await request(app).post('/api/auth/login').send({
            email: 'committee_sessions@example.com',
            password: 'Password123!'
        });
        const refreshCookies = refreshRes.headers['set-cookie'];
        const refreshCookieArray = Array.isArray(refreshCookies)
            ? refreshCookies
            : refreshCookies
              ? [refreshCookies]
              : [];
        const refreshCookie = refreshCookieArray.find((c: string) => c.startsWith('uscc_token='));
        committeeToken = refreshCookie ? refreshCookie.split(';')[0].split('=')[1] : '';
    });

    afterAll(async () => {
        db.close();
    });

    // Helper functions for test isolation
    const futureIso = (daysAhead = 7) => {
        const d = new Date();
        d.setDate(d.getDate() + daysAhead);
        d.setHours(18, 0, 0, 0);
        return d.toISOString();
    };

    const createSession = async (token: string, title: string, extra: Record<string, any> = {}) => {
        const res = await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${token}`)
            .send({
                title,
                type: 'Social',
                date: futureIso(7),
                capacity: 10,
                ...extra
            });
        return res.body.id;
    };

    const bookSession = async (token: string, sid: string) => {
        await request(app).post(`/api/sessions/${sid}/book`).set('Authorization', `Bearer ${token}`);
    };

    it('should allow committee to create a session', async () => {
        const res = await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'Test Session',
                type: 'Social',
                date: futureIso(7),
                capacity: 10
            });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('id');
    });

    it('should list sessions', async () => {
        const sessionId = await createSession(committeeToken, 'Listable Session');
        const res = await request(app).get('/api/sessions');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some((s: any) => s.id === sessionId)).toBe(true);
    });

    it('should hide committee-only sessions from non-committee users', async () => {
        const sessionId = await createSession(committeeToken, 'Committee Hidden Session', {
            visibility: 'committee_only'
        });
        const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body.some((s: any) => s.id === sessionId)).toBe(false);
    });

    it('should show committee-only sessions to committee users', async () => {
        const sessionId = await createSession(committeeToken, 'Committee Visible Session', {
            visibility: 'committee_only'
        });
        const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${committeeToken}`);

        expect(res.status).toBe(200);
        expect(res.body.some((s: any) => s.id === sessionId)).toBe(true);
    });

    it('should allow user to book a session', async () => {
        const sessionId = await createSession(committeeToken, 'Bookable Session');
        const res = await request(app)
            .post(`/api/sessions/${sessionId}/book`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should prevent double booking', async () => {
        const sessionId = await createSession(committeeToken, 'Double Bookable Session');
        await bookSession(userToken, sessionId);

        // Try booking again
        const res = await request(app)
            .post(`/api/sessions/${sessionId}/book`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Already booked this session');
    });

    it('should prevent non-committee users booking committee-restricted registration sessions', async () => {
        const sessionId = await createSession(committeeToken, 'Committee Booking Guard', {
            registrationVisibility: 'committee_only'
        });
        const res = await request(app)
            .post(`/api/sessions/${sessionId}/book`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty('error', 'Registration for this session is for committee members only.');
    });

    it('should allow non-committee users booking a committee-visible session when registration is open', async () => {
        const sessionId = await createSession(committeeToken, 'Visibility Only Restriction', {
            visibility: 'committee_only',
            registrationVisibility: 'all'
        });
        const res = await request(app)
            .post(`/api/sessions/${sessionId}/book`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should list publicly-visible but committee-registered sessions to non-committee users', async () => {
        const sessionId = await createSession(committeeToken, 'Registration Only Restriction', {
            visibility: 'all',
            registrationVisibility: 'committee_only'
        });
        const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body.some((s: any) => s.id === sessionId)).toBe(true);
    });

    it('should show user bookings', async () => {
        const sessionId = await createSession(committeeToken, 'My Booking Session');
        await bookSession(userToken, sessionId);

        const res = await request(app).get('/api/sessions/me/bookings').set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toContain(sessionId);
    });

    it('should allow user to cancel booking', async () => {
        const sessionId = await createSession(committeeToken, 'Cancel Booking Session');
        await bookSession(userToken, sessionId);

        const res = await request(app)
            .post(`/api/sessions/${sessionId}/cancel`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should allow committee to update a session', async () => {
        const sessionId = await createSession(committeeToken, 'Updateable Session');
        const res = await request(app)
            .put(`/api/sessions/${sessionId}`)
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'Updated Title',
                type: 'Training',
                date: futureIso(8),
                capacity: 20,
                bookedSlots: 0
            });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should allow committee to delete a session', async () => {
        const sessionId = await createSession(committeeToken, 'Deletable Session');
        const res = await request(app)
            .delete(`/api/sessions/${sessionId}`)
            .set('Authorization', `Bearer ${committeeToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);
    });

    it('should prevent booking a full session', async () => {
        // Create session with capacity 1
        const resCreate = await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'Full Session',
                type: 'Social',
                date: futureIso(9),
                capacity: 1
            });
        const sessionId = resCreate.body.id;

        // Book it once
        await bookSession(userToken, sessionId);

        // Another user tries to book
        const user2Res = await request(app).post('/api/auth/register').send({
            firstName: 'User',
            lastName: '2',
            email: 'user2_full@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'U2FULL'
        });
        const tokenCookie3 = (user2Res.headers['set-cookie'] as any)?.find((c: string) => c.startsWith('uscc_token='));
        const user2Token = tokenCookie3 ? tokenCookie3.split(';')[0].split('=')[1] : user2Res.body.token || '';

        const res = await request(app)
            .post(`/api/sessions/${sessionId}/book`)
            .set('Authorization', `Bearer ${user2Token}`);

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Session is full');
    });

    it('should prevent cancelling a booking you do not have', async () => {
        const sessionId = await createSession(committeeToken, 'Not Booked Session');
        const res = await request(app)
            .post(`/api/sessions/${sessionId}/cancel`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'You have not booked this session');
    });

    it('should generate iCal file for user bookings', async () => {
        // Get user profile
        const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${userToken}`);
        const user = meRes.body.user;
        const calendarToken = user.calendarToken;

        const sessionId = await createSession(committeeToken, 'iCal Session');
        await bookSession(userToken, sessionId);

        const res = await request(app).get(`/api/sessions/ical/${calendarToken}`);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/calendar');
        expect(res.text).toContain('BEGIN:VCALENDAR');
        expect(res.text).toContain('iCal Session');
    });

    it('should return an empty iCal feed when user has no bookings', async () => {
        // Fresh user with no bookings
        const user3Res = await request(app).post('/api/auth/register').send({
            firstName: 'User',
            lastName: '3',
            email: 'user3_ical@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'U3ICAL'
        });
        const tokenCookie = (user3Res.headers['set-cookie'] as any)?.find((c: string) => c.startsWith('uscc_token='));
        const user3Token = tokenCookie ? tokenCookie.split(';')[0].split('=')[1] : user3Res.body.token || '';

        const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${user3Token}`);
        const user3 = meRes.body.user;

        // Create sessions but do not book them
        await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'Public iCal Session',
                type: 'Social',
                date: futureIso(10),
                capacity: 20,
                visibility: 'all'
            });
        await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'Committee iCal Session',
                type: 'Meeting',
                date: futureIso(11),
                capacity: 20,
                visibility: 'committee_only'
            });

        const res = await request(app).get(`/api/sessions/ical/${user3.calendarToken}`);
        expect(res.status).toBe(200);
        expect(res.text).toContain('BEGIN:VCALENDAR');
        expect(res.text).toContain('END:VCALENDAR');
        expect(res.text).not.toContain('BEGIN:VEVENT');
    });

    it('should include only booked sessions in iCal', async () => {
        const user4Res = await request(app).post('/api/auth/register').send({
            firstName: 'User',
            lastName: '4',
            email: 'user4_ical@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'U4ICAL'
        });
        const tokenCookie = (user4Res.headers['set-cookie'] as any)?.find((c: string) => c.startsWith('uscc_token='));
        const user4Token = tokenCookie ? tokenCookie.split(';')[0].split('=')[1] : user4Res.body.token || '';
        const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${user4Token}`);
        const user4 = meRes.body.user;

        const bookedSessionId = await createSession(committeeToken, 'Booked iCal Session');
        const unbookedSessionId = await createSession(committeeToken, 'Unbooked iCal Session');
        await bookSession(user4Token, bookedSessionId);

        const res = await request(app).get(`/api/sessions/ical/${user4.calendarToken}`);
        expect(res.status).toBe(200);
        expect(res.text).toContain('Booked iCal Session');
        expect(res.text).not.toContain('Unbooked iCal Session');
        expect(res.text).toContain(bookedSessionId);
        expect(res.text).not.toContain(unbookedSessionId);
    });

    it('should include all visible sessions in all-sessions iCal feed for regular users', async () => {
        const user5Res = await request(app).post('/api/auth/register').send({
            firstName: 'User',
            lastName: '5',
            email: 'user5_ical@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'U5ICAL'
        });
        const tokenCookie = (user5Res.headers['set-cookie'] as any)?.find((c: string) => c.startsWith('uscc_token='));
        const user5Token = tokenCookie ? tokenCookie.split(';')[0].split('=')[1] : user5Res.body.token || '';
        const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${user5Token}`);
        const user5 = meRes.body.user;

        await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'All Feed Public Session',
                type: 'Social',
                date: futureIso(12),
                capacity: 20,
                visibility: 'all'
            });
        await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'All Feed Committee Session',
                type: 'Meeting',
                date: futureIso(13),
                capacity: 20,
                visibility: 'committee_only'
            });

        const res = await request(app).get(`/api/sessions/ical/${user5.calendarToken}/all`);
        expect(res.status).toBe(200);
        expect(res.text).toContain('All Feed Public Session');
        expect(res.text).not.toContain('All Feed Committee Session');
    });

    it('should include committee-only sessions in all-sessions iCal feed for committee users', async () => {
        const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${committeeToken}`);
        const committeeUser = meRes.body.user;

        await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'All Feed Committee Visible',
                type: 'Meeting',
                date: futureIso(14),
                capacity: 20,
                visibility: 'committee_only'
            });

        const res = await request(app).get(`/api/sessions/ical/${committeeUser.calendarToken}/all`);
        expect(res.status).toBe(200);
        expect(res.text).toContain('All Feed Committee Visible');
    });

    it('should allow committee to view session attendees', async () => {
        const sessionId = await createSession(committeeToken, 'Attendee View Session');
        await bookSession(userToken, sessionId);

        const res = await request(app)
            .get(`/api/sessions/${sessionId}/attendees`)
            .set('Authorization', `Bearer ${committeeToken}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some((u: any) => u.email === 'user@example.com')).toBe(true);
    });

    it('should allow committee to remove an attendee', async () => {
        const sessionId = await createSession(committeeToken, 'Attendee Removal Session');
        await bookSession(userToken, sessionId);

        // Get user ID
        const userRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${userToken}`);
        const userId = userRes.body.user.id;

        const res = await request(app)
            .delete(`/api/sessions/${sessionId}/attendees/${userId}`)
            .set('Authorization', `Bearer ${committeeToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('success', true);

        // Verify slot was freed
        const sessionRes = await request(app).get('/api/sessions');
        const session = sessionRes.body.find((s: any) => s.id === sessionId);
        expect(session.bookedSlots).toBe(0);
    });

    it('should prevent booking a past session', async () => {
        const resCreate = await request(app)
            .post('/api/sessions')
            .set('Authorization', `Bearer ${committeeToken}`)
            .send({
                title: 'Past Session',
                type: 'Social',
                date: '2020-01-01T10:00:00',
                capacity: 10
            });
        const sessionId = resCreate.body.id;

        const res = await request(app)
            .post(`/api/sessions/${sessionId}/book`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error', 'Cannot book a past session.');
    });

    describe('Database Errors', () => {
        it('should handle list sessions DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'all')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app).get('/api/sessions');
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle iCal DB errors (user fetch)', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app).get('/api/sessions/ical/1');
            expect(res.status).toBe(404);
            spy.mockRestore();
        });

        it('should handle iCal DB errors (sessions fetch)', async () => {
            // Get user info
            const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${userToken}`);
            const user = meRes.body.user;

            const { vi } = await import('vitest');
            const spyAll = vi
                .spyOn(db, 'all')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));

            const res = await request(app).get(`/api/sessions/ical/${user.calendarToken}`);
            expect(res.status).toBe(500);
            spyAll.mockRestore();
        });

        it('should handle create session DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app).post('/api/sessions').set('Authorization', `Bearer ${committeeToken}`).send({
                title: 'T',
                type: 'T',
                date: 'D',
                capacity: 1
            });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle update session DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app)
                .put('/api/sessions/1')
                .set('Authorization', `Bearer ${committeeToken}`)
                .send({
                    title: 'T',
                    type: 'T',
                    date: 'D',
                    capacity: 1,
                    bookedSlots: 1
                });
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle get bookings DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'all')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));
            const res = await request(app).get('/api/sessions/me/bookings').set('Authorization', `Bearer ${userToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });

        it('should handle book session DB errors', async () => {
            const { vi } = await import('vitest');
            const spyGet1 = vi.spyOn(db, 'get').mockImplementationOnce((query, params, cb) => cb(null, null)); // No booking yet
            const spyGet2 = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null)); // Fail fetching session

            const res = await request(app).post('/api/sessions/1/book').set('Authorization', `Bearer ${userToken}`);
            expect(res.status).toBe(404);
            spyGet1.mockRestore();
            spyGet2.mockRestore();
        });

        it('should handle cancel session DB errors (get booking)', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));

            const res = await request(app).post('/api/sessions/1/cancel').set('Authorization', `Bearer ${userToken}`);
            expect(res.status).toBe(400); // Route logic checks if booking returns falsy
            spyGet.mockRestore();
        });

        it('should handle cancel session DB errors (delete booking)', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) =>
                    cb(null, { id: 'booking1', userId: 'user', sessionId: '1' })
                );
            const spyRun = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => {
                    const callback = typeof cb === 'function' ? cb : typeof params === 'function' ? params : null;
                    if (callback) callback.call({}, null);
                    return db as any;
                })
                .mockImplementationOnce((query, params, cb) => {
                    const callback = typeof cb === 'function' ? cb : typeof params === 'function' ? params : null;
                    if (callback) callback.call({}, new Error('DB Error'));
                    return db as any;
                })
                .mockImplementationOnce((query, params, cb) => {
                    // Catch the ROLLBACK
                    const callback = typeof cb === 'function' ? cb : typeof params === 'function' ? params : null;
                    if (callback) callback.call({}, null);
                    return db as any;
                });

            const res = await request(app).post('/api/sessions/1/cancel').set('Authorization', `Bearer ${userToken}`);
            expect(res.status).toBe(500);
            expect(res.body).toHaveProperty('error', 'Database error on cancel');
            // wait for background db calls to settle before restoring spy
            await new Promise((r) => setTimeout(r, 20));
            spyGet.mockRestore();
            spyRun.mockRestore();
        });

        it('should handle cancel session DB errors (update session)', async () => {
            const { vi } = await import('vitest');
            const spyGet = vi
                .spyOn(db, 'get')
                .mockImplementationOnce((query, params, cb) =>
                    cb(null, { id: 'booking1', userId: 'user', sessionId: '1' })
                );
            const spyRun = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => {
                    const callback = typeof cb === 'function' ? cb : typeof params === 'function' ? params : null;
                    if (callback) callback.call({}, null);
                    return db as any;
                })
                .mockImplementationOnce((query, params, cb) => {
                    const callback = typeof cb === 'function' ? cb : typeof params === 'function' ? params : null;
                    if (callback) callback.call({}, null);
                    return db as any;
                })
                .mockImplementationOnce((query, params, cb) => {
                    const callback = typeof cb === 'function' ? cb : typeof params === 'function' ? params : null;
                    if (callback) callback.call({}, new Error('DB Error'));
                    return db as any;
                })
                .mockImplementationOnce((query, params, cb) => {
                    // Catch the ROLLBACK
                    const callback = typeof cb === 'function' ? cb : typeof params === 'function' ? params : null;
                    if (callback) callback.call({}, null);
                    return db as any;
                });

            const res = await request(app).post('/api/sessions/1/cancel').set('Authorization', `Bearer ${userToken}`);
            expect(res.status).toBe(500);
            expect(res.body).toHaveProperty('error', 'Database error on update');
            await new Promise((r) => setTimeout(r, 20));
            spyGet.mockRestore();
            spyRun.mockRestore();
        });

        it('should handle delete session DB errors', async () => {
            const { vi } = await import('vitest');
            const spy = vi
                .spyOn(db, 'run')
                .mockImplementationOnce((query, params, cb) => cb.call({}, new Error('DB Error')));
            const res = await request(app).delete('/api/sessions/1').set('Authorization', `Bearer ${committeeToken}`);
            expect(res.status).toBe(500);
            spy.mockRestore();
        });
    });
});
