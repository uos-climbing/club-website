import express from 'express';
import { dbAll, dbGet, dbRun } from '../utils/db';
import { authenticateToken, requireCommittee } from '../middleware/auth';

const router = express.Router();

function isSqliteConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'SQLITE_CONSTRAINT';
}

function normalizeMembershipTypeId(input: string): string {
    return input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

router.get('/', async (req, res) => {
    try {
        res.json(await dbAll('SELECT * FROM membership_types ORDER BY deprecated DESC, label ASC'));
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

router.post('/', authenticateToken, requireCommittee, async (req, res) => {
    const label = (req.body?.label || '').toString().trim();
    const providedId = (req.body?.id || '').toString().trim();
    const id = normalizeMembershipTypeId(providedId || label);

    if (!label) return res.status(400).json({ error: 'Label is required' });
    if (!id) return res.status(400).json({ error: 'Invalid membership type id' });

    try {
        await dbRun('INSERT INTO membership_types (id, label) VALUES (?, ?)', [id, label]);
        res.json({ id, label });
    } catch (err) {
        if (isSqliteConstraintError(err)) {
            return res.status(400).json({ error: 'Membership type already exists' });
        }
        res.status(500).json({ error: 'Database error' });
    }
});

router.put('/:id', authenticateToken, requireCommittee, async (req, res) => {
    const label = (req.body?.label || '').toString().trim();
    const deprecated = req.body?.deprecated ? 1 : 0;
    if (!label) return res.status(400).json({ error: 'Label is required' });

    const { changes } = await dbRun('UPDATE membership_types SET label = ?, deprecated = ? WHERE id = ?', [
        label,
        deprecated,
        req.params.id
    ]).catch(() => ({ changes: -1 }));

    if (changes < 0) return res.status(500).json({ error: 'Database error' });
    if (changes === 0) return res.status(404).json({ error: 'Membership type not found' });
    res.json({ id: req.params.id, label, deprecated });
});

router.delete('/:id', authenticateToken, requireCommittee, async (req, res) => {
    if (req.params.id === 'basic') {
        return res.status(400).json({ error: 'The basic membership type cannot be deleted' });
    }

    const countRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM membership_types').catch(
        () => undefined
    );
    if (countRow === undefined) return res.status(500).json({ error: 'Database error' });
    if ((countRow?.count || 0) <= 1) {
        return res.status(400).json({ error: 'At least one membership type must remain' });
    }

    try {
        const { changes } = await dbRun('DELETE FROM membership_types WHERE id = ?', [req.params.id]);
        if (changes === 0) return res.status(404).json({ error: 'Membership type not found' });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Database error' });
    }
});

export default router;
