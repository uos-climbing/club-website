import { standardDbResponse } from '../utils/response';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { dbAll, dbGet, dbRun, inTransaction, StagedError } from '../utils/db';
import { authenticateToken, requireCommittee } from '../middleware/auth';
import { SECRET_KEY } from '../config';
import { getDefaultMembershipTypeAsync, getMembershipLabel } from '../services/membership';
import { sendBookingConfirmation, sendCancellationConfirmation } from '../services/bookings';

const router = express.Router();

async function membershipTypeExists(membershipType: string): Promise<boolean> {
    const row = await dbGet('SELECT id FROM membership_types WHERE id = ?', [membershipType]);
    return !!row;
}

function buildIcalContent(userId: string, sessions: any[]) {
    let icalContent = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//USCC//Calendar//EN\r\n';
    sessions.forEach((s: any) => {
        const start = new Date(s.date);
        if (isNaN(start.getTime())) return;
        const end = new Date(start.getTime() + 2 * 60 * 60 * 1000); // 2 hour duration
        const formatDT = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

        icalContent += 'BEGIN:VEVENT\r\n';
        icalContent += `UID:${s.id}_${userId}@sheffieldclimbing.com\r\n`;
        icalContent += `DTSTAMP:${formatDT(new Date())}\r\n`;
        icalContent += `DTSTART:${formatDT(start)}\r\n`;
        icalContent += `DTEND:${formatDT(end)}\r\n`;
        icalContent += `SUMMARY:${s.title} (${s.type})\r\n`;
        if (s.location) {
            icalContent += `LOCATION:${s.location}\r\n`;
        }
        icalContent += 'END:VEVENT\r\n';
    });
    icalContent += 'END:VCALENDAR\r\n';
    return icalContent;
}

router.get('/', async (req, res) => {
    // Optional auth: public users can list sessions, but committee-only sessions
    // are only visible to committee users.
    let token: string | undefined = (req as any).cookies?.uscc_token;
    if (!token) {
        const authHeader = req.headers['authorization'];
        if (typeof authHeader === 'string') {
            token = authHeader.split(' ')[1];
        }
    }

    let isCommittee = false;
    if (token) {
        try {
            const user: any = jwt.verify(token, SECRET_KEY);
            isCommittee =
                user.role === 'committee' ||
                !!user.committeeRole ||
                (Array.isArray(user.committeeRoles) && user.committeeRoles.length > 0);
        } catch {
            isCommittee = false;
        }
    }

    const sql = isCommittee
        ? 'SELECT * FROM sessions ORDER BY date ASC'
        : 'SELECT * FROM sessions WHERE COALESCE(visibility, "all") != "committee_only" ORDER BY date ASC';

    try {
        res.json(await dbAll(sql));
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.get('/ical/:calendarToken', async (req, res) => {
    const calendarToken = req.params.calendarToken;
    const user = await dbGet<{ id: string }>('SELECT id FROM users WHERE calendarToken = ?', [calendarToken]).catch(
        () => undefined
    );
    if (!user) return res.status(404).send('User not found');
    const userId = user.id;

    try {
        const sessions = await dbAll(
            `
            SELECT s.* FROM sessions s
            JOIN bookings b ON s.id = b.sessionId
            WHERE b.userId = ?
            ORDER BY s.date ASC
        `,
            [userId]
        );
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="uscc_schedule_booked.ics"');
        res.send(buildIcalContent(userId, sessions));
    } catch {
        res.status(500).send('Database error');
    }
});

router.get('/ical/:calendarToken/all', async (req, res) => {
    const calendarToken = req.params.calendarToken;
    const user = await dbGet<{ id: string; role: string; committeeRole: string | null }>(
        'SELECT id, role, committeeRole FROM users WHERE calendarToken = ?',
        [calendarToken]
    ).catch(() => undefined);
    if (!user) return res.status(404).send('User not found');
    const userId = user.id;

    try {
        const roles = await dbAll<{ role: string }>('SELECT role FROM committee_roles WHERE userId = ?', [userId]);

        const isCommittee =
            user.role === 'committee' || !!user.committeeRole || (Array.isArray(roles) && roles.length > 0);

        const sql = isCommittee
            ? 'SELECT * FROM sessions ORDER BY date ASC'
            : 'SELECT * FROM sessions WHERE COALESCE(visibility, "all") != "committee_only" ORDER BY date ASC';

        const sessions = await dbAll(sql);
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="uscc_schedule_all.ics"');
        res.send(buildIcalContent(userId, sessions));
    } catch {
        res.status(500).send('Database error');
    }
});

router.post('/', authenticateToken, requireCommittee, async (req, res) => {
    const { title, type, date, capacity, location, requiredMembership, visibility, registrationVisibility } = req.body;
    const id = 'sess_' + crypto.randomUUID();
    const eventVisibility = visibility === 'committee_only' ? 'committee_only' : 'all';
    const eventRegistrationVisibility = registrationVisibility === 'committee_only' ? 'committee_only' : 'all';

    try {
        const defaultMembershipType = await getDefaultMembershipTypeAsync();
        if (!defaultMembershipType) return res.status(500).json({ error: 'No membership types configured' });

        const reqMemb = requiredMembership || defaultMembershipType;

        // Validate the requested membership type exists
        if (!(await membershipTypeExists(reqMemb))) {
            return res.status(400).json({ error: 'Invalid required membership type' });
        }

        await dbRun(
            'INSERT INTO sessions (id, type, title, date, capacity, bookedSlots, location, requiredMembership, visibility, registrationVisibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                id,
                type,
                title,
                date,
                capacity,
                0,
                location || null,
                reqMemb,
                eventVisibility,
                eventRegistrationVisibility
            ]
        );

        res.json({
            id,
            type,
            title,
            date,
            capacity,
            bookedSlots: 0,
            location: location || undefined,
            requiredMembership: reqMemb,
            visibility: eventVisibility,
            registrationVisibility: eventRegistrationVisibility
        });
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

/**
 * Create multiple sessions (Used by recurrance).
 * Rollback on any failure, so either all sessions are created or none.
 */
router.post('/bulk', authenticateToken, requireCommittee, async (req, res) => {
    const { sessions } = req.body;

    if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length > 50) {
        return res.status(400).json({ error: 'Provide between 1 and 50 sessions.' });
    }

    for (const session of sessions) {
        if (
            !session ||
            typeof session.title !== 'string' ||
            !session.title.trim() ||
            typeof session.type !== 'string' ||
            !session.type.trim() ||
            typeof session.date !== 'string' ||
            !session.date.trim() ||
            typeof session.capacity !== 'number' ||
            !Number.isInteger(session.capacity) ||
            session.capacity < 1
        ) {
            return res.status(400).json({ error: 'Invalid session data.' });
        }
    }

    try {
        const defaultMembershipType = await getDefaultMembershipTypeAsync();
        if (!defaultMembershipType) {
            return res.status(500).json({ error: 'No membership types configured' });
        }

        const preparedSessions: Array<{
            id: string;
            type: string;
            title: string;
            date: string;
            capacity: number;
            bookedSlots: number;
            location: string | null;
            requiredMembership: string;
            visibility: 'committee_only' | 'all';
            registrationVisibility: 'committee_only' | 'all';
        }> = [];

        for (const session of sessions) {
            const reqMemb = session.requiredMembership || defaultMembershipType;

            if (!(await membershipTypeExists(reqMemb))) {
                return res.status(400).json({ error: 'Invalid required membership type' });
            }

            preparedSessions.push({
                id: 'sess_' + crypto.randomUUID(),
                type: session.type,
                title: session.title,
                date: session.date,
                capacity: session.capacity,
                bookedSlots: 0,
                location: session.location || null,
                requiredMembership: reqMemb,
                visibility: session.visibility === 'committee_only' ? 'committee_only' : 'all',
                registrationVisibility:
                    session.registrationVisibility === 'committee_only' ? 'committee_only' : 'all'
            });
        }

        const createdSessions = await inTransaction(async () => {
            for (const session of preparedSessions) {
                await dbRun(
                    'INSERT INTO sessions (id, type, title, date, capacity, bookedSlots, location, requiredMembership, visibility, registrationVisibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        session.id,
                        session.type,
                        session.title,
                        session.date,
                        session.capacity,
                        session.bookedSlots,
                        session.location,
                        session.requiredMembership,
                        session.visibility,
                        session.registrationVisibility
                    ]
                );
            }

            return preparedSessions;
        });

        res.json(createdSessions);
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.put('/:id', authenticateToken, requireCommittee, async (req, res) => {
    const {
        title,
        type,
        date,
        capacity,
        bookedSlots,
        location,
        requiredMembership,
        visibility,
        registrationVisibility
    } = req.body;
    const eventVisibility = visibility === 'committee_only' ? 'committee_only' : 'all';
    const eventRegistrationVisibility = registrationVisibility === 'committee_only' ? 'committee_only' : 'all';

    try {
        const defaultMembershipType = await getDefaultMembershipTypeAsync();
        if (!defaultMembershipType) return res.status(500).json({ error: 'No membership types configured' });

        const reqMemb = requiredMembership || defaultMembershipType;

        if (!(await membershipTypeExists(reqMemb))) {
            return res.status(400).json({ error: 'Invalid required membership type' });
        }

        await dbRun(
            'UPDATE sessions SET title = ?, type = ?, date = ?, capacity = ?, bookedSlots = ?, location = ?, requiredMembership = ?, visibility = ?, registrationVisibility = ? WHERE id = ?',
            [
                title,
                type,
                date,
                capacity,
                bookedSlots,
                location || null,
                reqMemb,
                eventVisibility,
                eventRegistrationVisibility,
                req.params.id
            ]
        );
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.get('/me/bookings', authenticateToken, async (req: any, res) => {
    try {
        const rows = await dbAll('SELECT sessionId FROM bookings WHERE userId = ?', [req.user.id]);
        res.json(rows.map((r: any) => r.sessionId));
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/:id/book', authenticateToken, async (req: any, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    const existingBooking = await dbGet('SELECT * FROM bookings WHERE userId = ? AND sessionId = ?', [
        userId,
        sessionId
    ]);
    if (existingBooking) return res.status(400).json({ error: 'Already booked this session' });

    const session = await dbGet<any>(
        'SELECT capacity, bookedSlots, requiredMembership, visibility, registrationVisibility, date FROM sessions WHERE id = ?',
        [sessionId]
    ).catch(() => undefined);
    // Original treated query failure and missing row identically
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const sessionDate = new Date(session.date);
    if (sessionDate < new Date()) {
        return res.status(400).json({ error: 'Cannot book a past session.' });
    }

    if (session.bookedSlots >= session.capacity) return res.status(400).json({ error: 'Session is full' });

    const isCommittee =
        req.user.role === 'committee' ||
        !!req.user.committeeRole ||
        (Array.isArray(req.user.committeeRoles) && req.user.committeeRoles.length > 0);
    const registrationIsCommitteeOnly = (session.registrationVisibility || 'all') === 'committee_only';
    if (registrationIsCommitteeOnly && !isCommittee) {
        return res.status(403).json({ error: 'Registration for this session is for committee members only.' });
    }

    const reqMemb = session.requiredMembership || 'basic';

    const userMemb = await dbGet<any>(
        'SELECT * FROM user_memberships WHERE userId = ? AND membershipType = ? AND status = "active"',
        [userId, reqMemb]
    ).catch(() => null);

    if (userMemb === null) return res.status(500).json({ error: 'Database error checking membership' });

    // Enforce requirement unless they are root admin testing it
    if (!registrationIsCommitteeOnly && !userMemb && req.user.email !== 'committee@sheffieldclimbing.org') {
        return getMembershipLabel(reqMemb, (typeLabel: string) => {
            return res.status(403).json({ error: `This session requires an active ${typeLabel} membership.` });
        });
    }

    // Transactional booking: BEGIN IMMEDIATE…COMMIT inside the process-wide
    // serialized queue (see utils/db.ts) with a capacity-guarded conditional
    // UPDATE prevents oversell under concurrent requests — without the
    // cross-request interleaving that made raw db.serialize()+BEGIN crash the
    // server during a booking rush.
    try {
        const bookedSlots = await inTransaction(async () => {
            await dbRun('INSERT INTO bookings (userId, sessionId) VALUES (?, ?)', [userId, sessionId]).catch(() => {
                throw new StagedError('insert booking', 500, { error: 'Database error on booking' });
            });
            const { changes } = await dbRun(
                'UPDATE sessions SET bookedSlots = bookedSlots + 1 WHERE id = ? AND bookedSlots < capacity',
                [sessionId]
            ).catch(() => {
                throw new StagedError('increment bookedSlots', 500, { error: 'Database error on update' });
            });
            if (changes === 0) {
                throw new StagedError('capacity guard', 400, { error: 'Session is full' });
            }
            return session.bookedSlots + 1;
        });

        if (req.user.email) {
            void sendBookingConfirmation(req.user.email, req.user.firstName || req.user.name || 'there', session);
        }
        res.json({ success: true, bookedSlots });
    } catch (err) {
        if (err instanceof StagedError) return res.status(err.status).json(err.body);
        res.status(500).json({ error: 'Database error on booking' });
    }
});

router.post('/:id/cancel', authenticateToken, async (req: any, res) => {
    const userId = req.user.id;
    const sessionId = req.params.id;

    const booking = await dbGet('SELECT * FROM bookings WHERE userId = ? AND sessionId = ?', [userId, sessionId]).catch(
        () => undefined
    );
    // Original treated lookup failure the same as "not booked"
    if (!booking) return res.status(400).json({ error: 'You have not booked this session' });

    // Transactional cancel — see book() for rationale
    try {
        await inTransaction(async () => {
            const del = await dbRun('DELETE FROM bookings WHERE userId = ? AND sessionId = ?', [
                userId,
                sessionId
            ]).catch(() => {
                throw new StagedError('delete booking', 500, { error: 'Database error on cancel' });
            });
            if (del.changes === 0) {
                throw new StagedError('booking missing', 400, { error: 'You have not booked this session' });
            }
            // No changes===0 guard here (parity with previous behaviour): a
            // drifted bookedSlots of 0 still commits the booking deletion.
            await dbRun('UPDATE sessions SET bookedSlots = bookedSlots - 1 WHERE id = ? AND bookedSlots > 0', [
                sessionId
            ]).catch(() => {
                throw new StagedError('decrement bookedSlots', 500, { error: 'Database error on update' });
            });
        });

        // Fire-and-forget cancellation confirmation
        const titleRow = await dbGet<{ title: string }>('SELECT title FROM sessions WHERE id = ?', [sessionId]).catch(
            () => undefined
        );
        if (req.user.email && titleRow) {
            void sendCancellationConfirmation(req.user.email, req.user.firstName || req.user.name || 'there', titleRow);
        }

        res.json({ success: true });
    } catch (err) {
        if (err instanceof StagedError) return res.status(err.status).json(err.body);
        res.status(500).json({ error: 'Database error on cancel' });
    }
});

router.get('/:id/attendees', authenticateToken, requireCommittee, async (req, res) => {
    try {
        res.json(
            await dbAll(
                `
        SELECT u.id, u.firstName, u.lastName, u.name, u.email, u.registrationNumber 
        FROM users u
        JOIN bookings b ON u.id = b.userId
        WHERE b.sessionId = ?
    `,
                [req.params.id]
            )
        );
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.delete('/:id/attendees/:userId', authenticateToken, requireCommittee, async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.params.userId;

    // Transactional removal — see book() for rationale
    try {
        await inTransaction(async () => {
            const del = await dbRun('DELETE FROM bookings WHERE userId = ? AND sessionId = ?', [
                userId,
                sessionId
            ]).catch(() => {
                throw new StagedError('delete booking', 500, { error: 'Database error' });
            });
            if (del.changes === 0) {
                throw new StagedError('booking missing', 404, { error: 'Booking not found' });
            }
            // No changes===0 guard (parity with previous behaviour), see cancel().
            await dbRun('UPDATE sessions SET bookedSlots = bookedSlots - 1 WHERE id = ? AND bookedSlots > 0', [
                sessionId
            ]).catch(() => {
                throw new StagedError('decrement bookedSlots', 500, { error: 'Database error' });
            });
        });
        res.json({ success: true });
    } catch (err) {
        if (err instanceof StagedError) return res.status(err.status).json(err.body);
        res.status(500).json({ error: 'Database error' });
    }
});

router.delete('/:id', authenticateToken, requireCommittee, async (req, res) => {
    const { changes } = await dbRun('DELETE FROM sessions WHERE id = ?', [req.params.id]).catch(() => ({
        changes: -1
    }));
    if (changes < 0) return res.status(500).json({ error: 'Database error' });
    if (changes === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
});

export default router;