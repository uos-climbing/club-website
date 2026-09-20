import { db } from '../db';

type MembershipTypeRow = { id: string };
type MembershipLabelRow = { label: string };

export function getMembershipTypeIds(callback: (err: Error | null, ids: string[]) => void) {
    db.all('SELECT id FROM membership_types', [], (err: Error | null, rows: MembershipTypeRow[] | undefined) => {
        if (err) return callback(err, []);
        callback(null, (rows ?? []).map((row) => row.id));
    });
}

/** Promisified variant for async/await routes */
export function getMembershipTypeIdsAsync(): Promise<string[]> {
    return new Promise((resolve, reject) => {
        getMembershipTypeIds((typeErr, ids) => (typeErr ? reject(typeErr) : resolve(ids)));
    });
}

/** Promisified variant for async/await routes */
export function getDefaultMembershipTypeAsync(): Promise<string | null> {
    return new Promise((resolve, reject) => {
        getDefaultMembershipType((typeErr, id) => (typeErr ? reject(typeErr) : resolve(id)));
    });
}

export function getDefaultMembershipType(callback: (err: Error | null, membershipTypeId: string | null) => void) {
    db.get(
        `SELECT id FROM membership_types
         ORDER BY CASE WHEN id = 'basic' THEN 0 ELSE 1 END, label ASC
         LIMIT 1`,
        [],
        (err: Error | null, row: MembershipTypeRow | undefined) => {
            if (err) return callback(err, null);
            callback(null, row?.id || null);
        }
    );
}

export function getMembershipLabel(membershipType: string, callback: (label: string) => void) {
    db.get('SELECT label FROM membership_types WHERE id = ?', [membershipType], (err: Error | null, row: MembershipLabelRow | undefined) => {
        if (err || !row?.label) return callback(membershipType);
        callback(row.label);
    });
}
