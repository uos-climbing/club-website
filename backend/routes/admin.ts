import express from 'express';
import crypto from 'crypto';
import { authenticateToken, requireCommittee } from '../middleware/auth';
import { sendEmail } from '../services/email';
import { ROOT_ADMIN_EMAIL, isRootAdmin, parseSuRoster } from './admin.helpers';
import { logAudit } from '../services/audit';
import { getDefaultMembershipTypeAsync, getMembershipLabel } from '../services/membership';
import { dbAll, dbGet, dbRun } from '../utils/db';

const router = express.Router();

router.get('/config/elections', authenticateToken, requireCommittee, async (req, res) => {
    try {
        const row = await dbGet<{ value: string }>('SELECT value FROM config WHERE key = ?', ['electionsOpen']);
        res.json({ electionsOpen: row?.value === 'true' });
    } catch {
        return res.status(500).json({ error: 'Database error' });
    }
});

router.post('/config/elections', authenticateToken, requireCommittee, async (req: any, res) => {
    const { open } = req.body;
    await dbRun('UPDATE config SET value = ? WHERE key = ?', [open ? 'true' : 'false', 'electionsOpen']).then(
        () => {
            void logAudit(req.user, 'elections.toggle', 'config', 'electionsOpen', { open });
            res.json({ success: true, electionsOpen: open });
        },
        () => res.status(500).json({ error: 'Database error' })
    );
});

/** Send a test email (root admin only) */
router.post('/test-email', authenticateToken, requireCommittee, async (req: any, res) => {
    if (!isRootAdmin(req.user)) {
        return res.status(403).json({ error: 'Only Root Admin can perform this action' });
    }

    const target = req.user.email;
    void logAudit(req.user, 'admin.test-email', 'email', target);
    const sent = await sendEmail(
        target,
        'USMC Test Email',
        'This is a test email from the USMC admin portal.',
        '<p>This is a test email from the USMC admin portal.</p>'
    );

    res.json({
        success: true,
        sent,
        target
    });
});

/** Get all users with their membership rows joined */
router.get('/users', authenticateToken, requireCommittee, async (req, res) => {
    try {
        const users = await dbAll<any[]>(
            'SELECT id, firstName, lastName, email, registrationNumber, role, committeeRole, membershipStatus, membershipYear, emergencyContactName, emergencyContactMobile, pronouns, dietaryRequirements FROM users'
        );
        const memberships = await dbAll<any[]>('SELECT * FROM user_memberships');
        const committeeRoles = await dbAll<{ userId: string; role: string }>(
            'SELECT userId, role FROM committee_roles'
        );

        const membMap: Record<string, any[]> = {};
        memberships.forEach((m: any) => {
            if (!membMap[m.userId]) membMap[m.userId] = [];
            membMap[m.userId].push(m);
        });

        const rolesMap: Record<string, string[]> = {};
        committeeRoles.forEach((r) => {
            if (!rolesMap[r.userId]) rolesMap[r.userId] = [];
            rolesMap[r.userId].push(r.role);
        });

        res.json(
            users.map((u: any) => ({
                ...u,
                memberships: membMap[u.id] || [],
                committeeRoles: rolesMap[u.id] || []
            }))
        );
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/memberships/import-su-roster', authenticateToken, requireCommittee, async (req: any, res) => {
    try {
        const raw = (req.body?.raw || '').toString();
        if (!raw.trim()) return res.status(400).json({ error: 'No roster text provided' });

        const { lines, parsed, skipped, yearParsedFromSubscription, yearFallbackUsed } = parseSuRoster(raw);

        if (!lines.length) return res.status(400).json({ error: 'No valid lines found' });

        const defaultType = await getDefaultMembershipTypeAsync();
        if (!defaultType) return res.status(500).json({ error: 'No membership types configured' });

        if (!parsed.length) {
            return res.status(400).json({ error: 'No valid roster rows found', skipped });
        }

        let approvedExisting = 0;
        let preapprovedOnly = 0;

        for (const row of parsed) {
            const existingUser: any = await dbGet('SELECT id FROM users WHERE registrationNumber = ?', [
                row.registrationNumber
            ]);

            if (existingUser?.id) {
                await dbRun('UPDATE users SET membershipStatus = ?, membershipYear = ? WHERE id = ?', [
                    'active',
                    row.membershipYear,
                    existingUser.id
                ]);

                await dbRun(
                    'UPDATE user_memberships SET status = ? WHERE userId = ? AND membershipYear = ? AND status = ?',
                    ['active', existingUser.id, row.membershipYear, 'pending']
                );

                const basicExisting: any = await dbGet(
                    'SELECT id FROM user_memberships WHERE userId = ? AND membershipType = ? AND membershipYear = ?',
                    [existingUser.id, defaultType, row.membershipYear]
                );

                if (basicExisting?.id) {
                    await dbRun('UPDATE user_memberships SET status = ? WHERE id = ?', ['active', basicExisting.id]);
                } else {
                    await dbRun(
                        'INSERT INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
                        [`umem_${crypto.randomUUID()}`, existingUser.id, defaultType, 'active', row.membershipYear]
                    );
                }

                await dbRun('DELETE FROM preapproved_members WHERE registrationNumber = ?', [row.registrationNumber]);
                approvedExisting++;
                continue;
            }

            await dbRun(
                `INSERT INTO preapproved_members (registrationNumber, fullName, membershipYear, source, createdAt)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(registrationNumber) DO UPDATE SET
                    fullName = excluded.fullName,
                    membershipYear = excluded.membershipYear,
                    source = excluded.source,
                    createdAt = excluded.createdAt`,
                [row.registrationNumber, row.fullName, row.membershipYear, 'su_dashboard', Date.now()]
            );
            preapprovedOnly++;
        }

        res.json({
            success: true,
            totalLines: lines.length,
            parsedRows: parsed.length,
            approvedExisting,
            preapprovedOnly,
            yearParsedFromSubscription,
            yearFallbackUsed,
            skipped
        });
        void logAudit(req.user, 'roster.import', 'memberships', undefined, {
            parsedRows: parsed.length,
            approvedExisting,
            preapprovedOnly,
            skipped: skipped.length
        });
    } catch (err: any) {
        console.error('Failed to import SU roster:', err);
        res.status(500).json({ error: 'Failed to import SU roster' });
    }
});

/** Shared notification sender for approve/reject decisions */
async function notifyMembershipDecision(userId: string, approved: boolean): Promise<void> {
    const user = await dbGet<any>('SELECT firstName, lastName, email FROM users WHERE id = ?', [userId]).catch(
        () => undefined
    );
    if (!user) return;
    const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
    const subject = approved ? 'Membership Approved' : 'Membership Rejected';
    const text = approved
        ? `Hi ${displayName},\n\nYour membership for University of Sheffield Mountaineering & Climbing Club (USMC) has been approved.`
        : `Hi ${displayName},\n\nUnfortunately, your membership for University of Sheffield Mountaineering & Climbing Club (USMC) has been rejected.`;
    const html = approved
        ? `<p>Hi ${displayName},</p><p>Your membership for University of Sheffield Mountaineering &amp; Climbing Club (USMC) has been approved.</p>`
        : `<p>Hi ${displayName},</p><p>Unfortunately, your membership for University of Sheffield Mountaineering &amp; Climbing Club (USMC) has been rejected.</p>`;
    await sendEmail(user.email, subject, text, html).catch((e: any) =>
        console.error(`Failed to send ${subject.toLowerCase()} email:`, e)
    );
}

router.post('/users/:id/approve', authenticateToken, requireCommittee, async (req: any, res) => {
    try {
        await dbRun('UPDATE users SET membershipStatus = ? WHERE id = ?', ['active', req.params.id]);

        // Side-effects: mirror original fire-and-forget behaviour (response was sent
        // before these completed). Membership-row sync runs best-effort.
        void (async () => {
            try {
                const defaultMembershipType = await getDefaultMembershipTypeAsync();
                if (!defaultMembershipType) return;

                const userRow = await dbGet<{ membershipYear: string }>(
                    'SELECT membershipYear FROM users WHERE id = ?',
                    [req.params.id]
                );
                if (!userRow) return;
                const year = userRow.membershipYear;

                const existing = await dbGet<{ id: string }>(
                    'SELECT id FROM user_memberships WHERE userId = ? AND membershipType = ? AND membershipYear = ?',
                    [req.params.id, defaultMembershipType, year]
                );
                if (existing) {
                    await dbRun('UPDATE user_memberships SET status = ? WHERE id = ?', ['active', existing.id]);
                } else {
                    await dbRun(
                        'INSERT INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
                        [`umem_${crypto.randomUUID()}`, req.params.id, defaultMembershipType, 'active', year]
                    );
                }
            } catch (e) {
                console.error('Approve: membership-row sync failed:', e);
            }
        })();

        await notifyMembershipDecision(req.params.id, true);
        void logAudit(req.user, 'member.approve', 'user', req.params.id);

        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/users/:id/reject', authenticateToken, requireCommittee, async (req: any, res) => {
    try {
        await dbRun('UPDATE users SET membershipStatus = ? WHERE id = ?', ['rejected', req.params.id]);

        void (async () => {
            try {
                const defaultMembershipType = await getDefaultMembershipTypeAsync();
                if (!defaultMembershipType) return;
                const userRow = await dbGet<{ membershipYear: string }>(
                    'SELECT membershipYear FROM users WHERE id = ?',
                    [req.params.id]
                );
                if (userRow) {
                    await dbRun(
                        'UPDATE user_memberships SET status = ? WHERE userId = ? AND membershipType = ? AND membershipYear = ?',
                        ['rejected', req.params.id, defaultMembershipType, userRow.membershipYear]
                    );
                }
            } catch (e) {
                console.error('Reject: membership-row sync failed:', e);
            }
        })();

        await notifyMembershipDecision(req.params.id, false);
        void logAudit(req.user, 'member.reject', 'user', req.params.id);

        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/users/:id/promote', authenticateToken, requireCommittee, async (req: any, res) => {
    if (!isRootAdmin(req.user)) {
        return res.status(403).json({ error: 'Only Root Admin can perform this action' });
    }

    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['committee', req.params.id]).then(
        () => {
            void logAudit(req.user, 'member.promote', 'user', req.params.id);
            res.json({ success: true });
        },
        () => res.status(500).json({ error: 'Database error' })
    );
});

router.post('/users/:id/demote', authenticateToken, requireCommittee, async (req: any, res) => {
    // Only root admin can demote
    if (!isRootAdmin(req.user)) {
        return res.status(403).json({ error: 'Only Root Admin can perform this action' });
    }

    // Cannot demote root admin
    const user = await dbGet<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.params.id]).catch(
        () => undefined
    );
    if (user === undefined) return res.status(500).json({ error: 'Database error' });
    if (user && typeof user.email === 'string' && user.email.toLowerCase() === ROOT_ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Cannot demote the Root Admin' });
    }

    try {
        await dbRun('UPDATE users SET role = ?, committeeRole = ? WHERE id = ?', ['member', null, req.params.id]);
        // Also clear all committee roles from the junction table
        await dbRun('DELETE FROM committee_roles WHERE userId = ?', [req.params.id]);
        void logAudit(req.user, 'member.demote', 'user', req.params.id);
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/users/:id/committee-role', authenticateToken, requireCommittee, async (req: any, res) => {
    // Accept either committeeRoles (array) or legacy committeeRole (string) for backward compat
    let roles: string[] = [];
    if (Array.isArray(req.body.committeeRoles)) {
        roles = req.body.committeeRoles;
    } else if (req.body.committeeRole !== undefined) {
        // Legacy single-role path
        roles = req.body.committeeRole ? [req.body.committeeRole] : [];
    }

    try {
        // Validate all roles against available roles from database
        const validRolesRows = await dbAll<{ id: string }>('SELECT id FROM available_roles');
        const validRoles = validRolesRows.map((r) => r.id);

        const invalidRole = roles.find((r) => !validRoles.includes(r));
        if (invalidRole) {
            return res.status(400).json({ error: 'Invalid committee role' });
        }

        const legacyRole = roles.length > 0 ? roles[0] : null;

        // Update legacy column for backward compatibility, then replace committee_roles rows
        await dbRun('UPDATE users SET committeeRole = ? WHERE id = ?', [legacyRole, req.params.id]);
        await dbRun('DELETE FROM committee_roles WHERE userId = ?', [req.params.id]);

        if (roles.length === 0) {
            return res.json({ success: true });
        }

        for (const r of roles) {
            await dbRun('INSERT OR IGNORE INTO committee_roles (userId, role) VALUES (?, ?)', [req.params.id, r]);
        }
        void logAudit(req.user, 'roles.assign', 'user', req.params.id, { roles });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

/** Approve a specific user_memberships row */
router.post('/memberships/:id/approve', authenticateToken, requireCommittee, async (req: any, res) => {
    let row: any;
    try {
        row = await dbGet('SELECT * FROM user_memberships WHERE id = ?', [req.params.id]);
    } catch {
        return res.status(500).json({ error: 'Database error' });
    }
    if (!row) return res.status(404).json({ error: 'Membership row not found' });

    const updated = await dbRun('UPDATE user_memberships SET status = ? WHERE id = ?', ['active', req.params.id]).catch(
        () => null
    );
    if (updated === null) return res.status(500).json({ error: 'Database error' });

    void logAudit(req.user, 'membership.approve', 'user_memberships', req.params.id, { type: row.membershipType });
    // Fire-and-forget side effects (original did not wait for these either)
    void (async () => {
        // If this is a 'basic' membership approval, also set the user's top-level membershipStatus to active
        if (row.membershipType === 'basic') {
            await dbRun('UPDATE users SET membershipStatus = ? WHERE id = ?', ['active', row.userId]).catch(() => {});
        }

        // Notify the user
        const user = await dbGet<any>('SELECT firstName, lastName, email FROM users WHERE id = ?', [row.userId]).catch(
            () => undefined
        );
        if (user) {
            const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
            const typeLabel = await new Promise<string>((resolve) => {
                getMembershipLabel(row.membershipType, (label: string) => resolve(label));
            });
            await sendEmail(
                user.email,
                'Membership Type Approved',
                `Hi ${displayName},\n\nYour ${typeLabel} membership for ${row.membershipYear} has been approved.`,
                `<p>Hi ${displayName},</p><p>Your <strong>${typeLabel}</strong> membership for ${row.membershipYear} has been approved.</p>`
            ).catch((e: any) => console.error('Failed to send membership approval email:', e));
        }
    })();

    res.json({ success: true });
});

/** Reject a specific user_memberships row */
router.post('/memberships/:id/reject', authenticateToken, requireCommittee, async (req: any, res) => {
    let row: any;
    try {
        row = await dbGet('SELECT * FROM user_memberships WHERE id = ?', [req.params.id]);
    } catch {
        return res.status(500).json({ error: 'Database error' });
    }
    if (!row) return res.status(404).json({ error: 'Membership row not found' });

    const updated = await dbRun('UPDATE user_memberships SET status = ? WHERE id = ?', [
        'rejected',
        req.params.id
    ]).catch(() => null);
    if (updated === null) return res.status(500).json({ error: 'Database error' });

    void logAudit(req.user, 'membership.reject', 'user_memberships', req.params.id, { type: row.membershipType });

    void (async () => {
        // If this is a 'basic' membership rejection, also set the user's top-level membershipStatus to rejected
        if (row.membershipType === 'basic') {
            await dbRun('UPDATE users SET membershipStatus = ? WHERE id = ?', ['rejected', row.userId]).catch(() => {});
        }

        const user = await dbGet<any>('SELECT firstName, lastName, email FROM users WHERE id = ?', [row.userId]).catch(
            () => undefined
        );
        if (user) {
            const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
            const typeLabel = await new Promise<string>((resolve) => {
                getMembershipLabel(row.membershipType, (label: string) => resolve(label));
            });
            await sendEmail(
                user.email,
                'Membership Type Request Rejected',
                `Hi ${displayName},\n\nYour request for ${typeLabel} membership for ${row.membershipYear} has been rejected.`,
                `<p>Hi ${displayName},</p><p>Your request for <strong>${typeLabel}</strong> membership for ${row.membershipYear} has been rejected.</p>`
            ).catch((e: any) => console.error('Failed to send membership rejection email:', e));
        }
    })();

    res.json({ success: true });
});

/** Delete a specific user_memberships row */
router.delete('/memberships/:id', authenticateToken, requireCommittee, async (req: any, res) => {
    let row: any;
    try {
        row = await dbGet('SELECT * FROM user_memberships WHERE id = ?', [req.params.id]);
    } catch {
        return res.status(500).json({ error: 'Database error' });
    }
    if (!row) return res.status(404).json({ error: 'Membership row not found' });

    const deleted = await dbRun('DELETE FROM user_memberships WHERE id = ?', [req.params.id]).catch(() => null);
    if (deleted === null) return res.status(500).json({ error: 'Database error' });

    void logAudit(req.user, 'membership.delete', 'user_memberships', req.params.id, { type: row.membershipType });

    // If we just deleted the user's only active basic membership, mark them as pending
    if (row.membershipType === 'basic') {
        const remaining = await dbGet(
            'SELECT id FROM user_memberships WHERE userId = ? AND membershipType = ? AND status = ?',
            [row.userId, 'basic', 'active']
        ).catch(() => undefined);

        // Original fired this update without checking the lookup error; preserved
        if (!remaining) {
            await dbRun('UPDATE users SET membershipStatus = ? WHERE id = ?', ['pending', row.userId]).catch(() => {});
        }
    }

    res.json({ success: true });
});

/** Get all available committee roles (committee members can read) */
router.get('/committee-roles', authenticateToken, requireCommittee, async (req: any, res) => {
    try {
        res.json(await dbAll<{ id: string; label: string }>('SELECT id, label FROM available_roles ORDER BY id ASC'));
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

/** Create a new committee role (root admin only) */
router.post('/committee-roles', authenticateToken, requireCommittee, async (req: any, res) => {
    if (!isRootAdmin(req.user)) {
        return res.status(403).json({ error: 'Only Root Admin can perform this action' });
    }

    const { id, label } = req.body;
    if (!id || !label) {
        return res.status(400).json({ error: 'Role ID and label are required' });
    }

    try {
        await dbRun('INSERT INTO available_roles (id, label) VALUES (?, ?)', [id, label]);
        void logAudit(req.user, 'role.create', 'available_roles', id, { label });
        res.json({ success: true, id, label });
    } catch (err: any) {
        if (err?.message?.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Role ID already exists' });
        }
        res.status(500).json({ error: 'Database error' });
    }
});

/** Update a committee role (root admin only) */
router.put('/committee-roles/:id', authenticateToken, requireCommittee, async (req: any, res) => {
    if (!isRootAdmin(req.user)) {
        return res.status(403).json({ error: 'Only Root Admin can perform this action' });
    }

    const { label } = req.body;
    if (!label) {
        return res.status(400).json({ error: 'Label is required' });
    }

    const { changes } = await dbRun('UPDATE available_roles SET label = ? WHERE id = ?', [label, req.params.id]).catch(
        () => ({ changes: -1 })
    );
    if (changes < 0) return res.status(500).json({ error: 'Database error' });
    if (changes === 0) {
        return res.status(404).json({ error: 'Role not found' });
    }
    void logAudit(req.user, 'role.update', 'available_roles', req.params.id, { label });
    res.json({ success: true, id: req.params.id, label });
});

/** Delete a committee role (root admin only) */
router.delete('/committee-roles/:id', authenticateToken, requireCommittee, async (req: any, res) => {
    if (!isRootAdmin(req.user)) {
        return res.status(403).json({ error: 'Only Root Admin can perform this action' });
    }

    // Check if any users currently hold this role
    const row = await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM committee_roles WHERE role = ?', [
        req.params.id
    ]).catch(() => undefined);
    if (row === undefined) return res.status(500).json({ error: 'Database error' });

    if (row && row.count > 0) {
        return res.status(400).json({
            error: 'Cannot delete a role that is assigned to users. Remove the role from all users first.'
        });
    }

    const { changes } = await dbRun('DELETE FROM available_roles WHERE id = ?', [req.params.id]).catch(() => ({
        changes: -1
    }));
    if (changes < 0) return res.status(500).json({ error: 'Database error' });
    if (changes === 0) {
        return res.status(404).json({ error: 'Role not found' });
    }
    void logAudit(req.user, 'role.delete', 'available_roles', req.params.id);
    res.json({ success: true });
});

/** Read the audit trail (committee only), newest first */
router.get('/audit-log', authenticateToken, requireCommittee, async (req: any, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset)) || 0, 0);
    try {
        const rows = await dbAll<any[]>('SELECT * FROM audit_log ORDER BY createdAt DESC LIMIT ? OFFSET ?', [
            limit,
            offset
        ]);
        res.json((rows || []).map((r: any) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })));
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

export default router;
