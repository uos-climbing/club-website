import express from 'express';
import bcrypt from 'bcrypt';
import { authenticateToken } from '../middleware/auth';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { UPLOAD_BASE_DIR } from '../config';
import { memoryUpload as upload } from '../utils/upload';
import { getMembershipTypeIdsAsync } from '../services/membership';
import { dbAll, dbGet, dbRun } from '../utils/db';

const router = express.Router();

// Configure multer for profile photo uploads
const uploadDir = path.join(UPLOAD_BASE_DIR, 'profile-photos');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

/** Get current user's membership rows */
router.get('/me/memberships', authenticateToken, async (req: any, res) => {
    try {
        res.json(
            await dbAll(
                'SELECT * FROM user_memberships WHERE userId = ? ORDER BY membershipYear DESC, membershipType ASC',
                [req.user.id]
            )
        );
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

/** Get current user's full profile details */
router.get('/me/profile', authenticateToken, async (req: any, res) => {
    const user = await dbGet(
        'SELECT firstName, lastName, emergencyContactName, emergencyContactMobile, pronouns, dietaryRequirements, profilePhoto, registrationNumber, membershipStatus, membershipYear FROM users WHERE id = ?',
        [req.user.id]
    ).catch(() => undefined);

    if (user === undefined) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

/** POST /api/users/me/photo - Upload profile photo */
router.post('/me/photo', authenticateToken, (req: any, res) => {
    upload.single('photo')(req, res, async (uploadErr: any) => {
        if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Photo too large. Max size is 5MB.' });
        }
        if (uploadErr) {
            return res.status(400).json({ error: uploadErr.message || 'Invalid image upload.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const filename = 'profile-' + uniqueSuffix + '.webp';
        const photoPath = `/uploads/profile-photos/${filename}`;
        const fullPath = path.join(UPLOAD_BASE_DIR, 'profile-photos', filename);

        // Transcode with sharp to strip metadata and prevent polyglot/infected images
        try {
            await sharp(req.file.buffer)
                .resize(500, 500, { fit: sharp.fit.cover })
                .webp({ quality: 80 })
                .toFile(fullPath);
        } catch (error) {
            console.error('Sharp processing error:', error);
            return res.status(500).json({ error: 'Failed to process image' });
        }

        // Get old photo to delete it (lookup errors ignored — same as before)
        const oldUser = await dbGet<{ profilePhoto: string | null }>('SELECT profilePhoto FROM users WHERE id = ?', [
            req.user.id
        ]).catch(() => undefined);
        if (oldUser?.profilePhoto) {
            const oldPath = path.join(UPLOAD_BASE_DIR, oldUser.profilePhoto.replace(/^\/uploads\//, ''));
            if (fs.existsSync(oldPath)) {
                try {
                    fs.unlinkSync(oldPath);
                } catch (e) {
                    console.error('Failed to delete old photo:', e);
                }
            }
        }

        const updated = await dbRun('UPDATE users SET profilePhoto = ? WHERE id = ?', [photoPath, req.user.id]).catch(
            () => null
        );
        if (updated === null) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, photoPath });
    });
});

/** Request an additional (or new) membership type */
router.post('/me/memberships', authenticateToken, async (req: any, res) => {
    const { membershipType, membershipYear } = req.body;

    if (!membershipType) return res.status(400).json({ error: 'membershipType is required' });

    let membershipTypeIds: string[];
    try {
        membershipTypeIds = await getMembershipTypeIdsAsync();
    } catch {
        return res.status(500).json({ error: 'Database error' });
    }

    if (!membershipTypeIds.includes(membershipType)) {
        return res.status(400).json({ error: 'Invalid membership type' });
    }

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth();
    const year =
        membershipYear ||
        (currentMonth < 8 ? `${currentYear - 1}/${currentYear}` : `${currentYear}/${currentYear + 1}`);

    const id = 'umem_' + crypto.randomUUID();
    // Committee members get auto-approved memberships
    const status = req.user.role === 'committee' ? 'active' : 'pending';

    // Try to insert; if a row already exists for (userId, membershipType, membershipYear), upgrade its status
    const inserted = await dbRun(
        'INSERT OR IGNORE INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
        [id, req.user.id, membershipType, status, year]
    ).catch(() => null);

    if (inserted === null) return res.status(500).json({ error: 'Database error' });

    if (inserted.changes === 0) {
        // Row already exists — upgrade status if the requested status is higher priority
        const upgraded = await dbRun(
            `UPDATE user_memberships SET status = ?
             WHERE userId = ? AND membershipType = ? AND membershipYear = ?
               AND (status = 'rejected' OR (status = 'pending' AND ? = 'active'))`,
            [status, req.user.id, membershipType, year, status]
        ).catch(() => null);

        if (upgraded === null) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, membershipType, status, membershipYear: year });
    } else {
        res.json({ success: true, id, membershipType, status, membershipYear: year });
    }
});

/** Renew overall membership (resets to pending for current year, or active for committee) */
router.post('/me/membership-renewal', authenticateToken, async (req: any, res) => {
    const { membershipYear, membershipTypes } = req.body;
    if (!membershipYear) return res.status(400).json({ error: 'Missing membership year' });

    // Committee members stay active; regular members go to pending
    const newStatus = req.user.role === 'committee' ? 'active' : 'pending';

    let membershipTypeIds: string[];
    try {
        membershipTypeIds = await getMembershipTypeIdsAsync();
    } catch {
        return res.status(500).json({ error: 'Database error' });
    }

    const updated = await dbRun('UPDATE users SET membershipYear = ?, membershipStatus = ? WHERE id = ?', [
        membershipYear,
        newStatus,
        req.user.id
    ]).catch(() => null);
    if (updated === null) return res.status(500).json({ error: 'Database error' });

    // Optionally insert new membership type rows for the new year
    if (Array.isArray(membershipTypes) && membershipTypes.length > 0) {
        const validTypes = membershipTypes.filter((t: string) => membershipTypeIds.includes(t));
        for (const t of validTypes) {
            // Original prepared-statement loop ignored per-row failures; preserved
            await dbRun(
                'INSERT INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
                ['umem_' + crypto.randomUUID(), req.user.id, t, newStatus, membershipYear]
            ).catch(() => {});
        }
    }

    res.json({ success: true, membershipYear, membershipStatus: newStatus });
});

/** Re-request membership (e.g. after rejection) */
router.post('/me/request-membership', authenticateToken, async (req: any, res) => {
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth();
    const membershipYear = currentMonth < 8 ? `${currentYear - 1}/${currentYear}` : `${currentYear}/${currentYear + 1}`;

    let membershipTypeIds: string[];
    try {
        membershipTypeIds = await getMembershipTypeIdsAsync();
    } catch {
        return res.status(500).json({ error: 'Database error' });
    }
    const defaultMembershipType = membershipTypeIds.includes('basic') ? 'basic' : membershipTypeIds[0];
    if (!defaultMembershipType) {
        return res.status(500).json({ error: 'No membership types configured' });
    }

    const updated = await dbRun('UPDATE users SET membershipStatus = ?, membershipYear = ? WHERE id = ?', [
        'pending',
        membershipYear,
        req.user.id
    ]).catch(() => null);
    if (updated === null) return res.status(500).json({ error: 'Database error' });

    // Upsert a default membership row so it appears in the admin pending list
    const row = await dbGet<{ id: string }>(
        'SELECT id FROM user_memberships WHERE userId = ? AND membershipType = ? AND membershipYear = ?',
        [req.user.id, defaultMembershipType, membershipYear]
    ).catch(() => undefined);

    if (row?.id) {
        // Row exists — update its status back to pending
        await dbRun('UPDATE user_memberships SET status = ? WHERE id = ?', ['pending', row.id]).catch(() => {});
    } else {
        // No row for this year yet — insert a fresh pending one
        await dbRun(
            'INSERT INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
            ['umem_' + crypto.randomUUID(), req.user.id, defaultMembershipType, 'pending', membershipYear]
        ).catch(() => {});
    }

    res.json({ success: true, membershipStatus: 'pending', membershipYear });
});

router.put('/:id', authenticateToken, async (req: any, res) => {
    if (req.user.id !== req.params.id && req.user.role !== 'committee') {
        return res.status(403).json({ error: 'Unauthorized to update this user' });
    }

    const { firstName, lastName, emergencyContactName, emergencyContactMobile, pronouns, dietaryRequirements } =
        req.body;
    await dbRun(
        'UPDATE users SET firstName = ?, lastName = ?, name = ?, emergencyContactName = ?, emergencyContactMobile = ?, pronouns = ?, dietaryRequirements = ? WHERE id = ?',
        [
            firstName,
            lastName,
            `${firstName} ${lastName}`.trim(),
            emergencyContactName,
            emergencyContactMobile,
            pronouns,
            dietaryRequirements,
            req.params.id
        ]
    ).then(
        () => res.json({ success: true }),
        () => res.status(500).json({ error: 'Database error' })
    );
});

router.put('/me/password', authenticateToken, async (req: any, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = await dbGet<{ passwordHash: string }>('SELECT passwordHash FROM users WHERE id = ?', [
        req.user.id
    ]).catch(() => undefined);
    if (user === undefined || !user) return res.status(500).json({ error: 'Database error' });

    const validPassword = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!validPassword) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await dbRun('UPDATE users SET passwordHash = ? WHERE id = ?', [newHash, req.user.id]).then(
        () => res.json({ success: true }),
        () => res.status(500).json({ error: 'Database error' })
    );
});

router.delete('/:id', authenticateToken, async (req: any, res) => {
    const targetUserId = req.params.id;
    const isSelf = req.user.id.toString() === targetUserId.toString();
    const isCommittee = req.user.role === 'committee';

    if (!isSelf && !isCommittee) {
        return res.status(403).json({ error: 'Unauthorized to delete this user' });
    }

    if (!isSelf && isCommittee) {
        const targetUser = await dbGet<{ role: string }>('SELECT role FROM users WHERE id = ?', [targetUserId]).catch(
            () => null
        );
        if (!targetUser) return res.status(500).json({ error: 'User not found or database error' });
        if (targetUser.role === 'committee') {
            return res.status(403).json({ error: 'Cannot delete another committee member' });
        }
        await performUserDelete(targetUserId, res);
    } else {
        await performUserDelete(targetUserId, res);
    }
});

// Cascade deletes ignore individual intermediate failures (same as the original
// chained callbacks); only the final users-row delete reports errors.
async function performUserDelete(userId: string, res: any) {
    for (const sql of [
        'DELETE FROM bookings WHERE userId = ?',
        'DELETE FROM votes WHERE userId = ?',
        'DELETE FROM candidates WHERE userId = ?',
        'DELETE FROM user_memberships WHERE userId = ?'
    ]) {
        await dbRun(sql, [userId]).catch(() => {});
    }
    await dbRun('DELETE FROM users WHERE id = ?', [userId]).then(
        () => res.json({ success: true }),
        () => res.status(500).json({ error: 'Database error' })
    );
}

export default router;
