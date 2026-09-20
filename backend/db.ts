import sqlite3 from 'sqlite3';
import type { RunResult } from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { DEV_ROOT_PASSWORD } from './config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_ADMIN_EMAIL = (process.env.ROOT_ADMIN_EMAIL || 'committee@sheffieldclimbing.org').toLowerCase();

type UserNameRow = { id: string; name: string | null };
type UserIdRow = { id: string };
type RootUserRow = { id: string; membershipYear: string | null };
type CountRow = { count: number };
type ConfigRow = { value: string };

// DB_PATH overrides the location everywhere except the test suite (which always
// uses :memory:) — enables prod-mode smoke tests outside containers.
const dbPath =
    process.env.NODE_ENV === 'test'
        ? ':memory:'
        : process.env.DB_PATH || (process.env.NODE_ENV === 'production' ? '/data/uscc.db' : join(__dirname, 'uscc.db'));
export const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        // Admin Audit Trail: append-only record of privileged actions.
        // details holds a JSON blob; createdAt is epoch ms.
        db.run(`CREATE TABLE IF NOT EXISTS audit_log (
            id TEXT PRIMARY KEY,
            actorId TEXT,
            actorEmail TEXT,
            action TEXT NOT NULL,
            entityType TEXT,
            entityId TEXT,
            details TEXT,
            createdAt INTEGER NOT NULL
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (createdAt DESC)');

        // Write-Ahead Logging: readers no longer block the writer (and vice versa)
        // under concurrent booking traffic. Safe with our backup script, which uses
        // SQLite's online backup API.
        db.run('PRAGMA journal_mode = WAL;');

        // busy_timeout: with WAL enabled a held write lock previously made read
        // callbacks queue silently (the suspected cause of Cloudflare ~100s origin
        // timeouts / 504s on /api/auth/me etc — docs/BUILD_IMPROVEMENTS.md P0-B).
        // Give the writer up to 5s to acquire the lock before surfacing SQLITE_BUSY.
        db.run('PRAGMA busy_timeout = 5000;');

        // foreign_keys: the schema declares REFERENCES clauses but SQLite ignores
        // them unless this per-connection pragma is on. Enforce from now on, and
        // log (read-only check, no data changes) any pre-existing violations at
        // boot so legacy rows can be remediated before they bite as write failures.
        db.run('PRAGMA foreign_keys = ON;');
        db.all('PRAGMA foreign_key_check;', [], (err, rows) => {
            if (err) {
                console.error('foreign_key_check failed:', err.message);
            } else if (rows.length > 0) {
                console.error(
                    `[FK] ${rows.length} existing foreign key violation(s) at boot — ` +
                        'enforcement is now ON; remediate these rows (sample of first 10):',
                    JSON.stringify(rows.slice(0, 10))
                );
            }
        });

        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            firstName TEXT,
            lastName TEXT,
            name TEXT, -- Keep for backward compatibility during migration
            email TEXT UNIQUE NOT NULL,
            passwordHash TEXT NOT NULL,
            registrationNumber TEXT,
            emergencyContactName TEXT,
            emergencyContactMobile TEXT,
            pronouns TEXT,
            dietaryRequirements TEXT,
            role TEXT DEFAULT 'member',
            committeeRole TEXT,
            membershipStatus TEXT DEFAULT 'pending',
            membershipYear TEXT,
            calendarToken TEXT UNIQUE,
            emailVerified INTEGER DEFAULT 0,
            instagram TEXT,
            faveCrag TEXT,
            bio TEXT,
            profilePhoto TEXT
        )`);

        // Email Verifications Table (OTP storage)
        db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
            userId TEXT NOT NULL,
            code TEXT NOT NULL,
            expiresAt INTEGER NOT NULL,
            PRIMARY KEY (userId)
        )`);

        // Pre-approved membership imports (keyed by registration number)
        db.run(`CREATE TABLE IF NOT EXISTS preapproved_members (
            registrationNumber TEXT PRIMARY KEY,
            fullName TEXT,
            membershipYear TEXT NOT NULL,
            source TEXT,
            createdAt INTEGER NOT NULL
        )`);

        // Password Reset Tokens Table
        db.run(`CREATE TABLE IF NOT EXISTS password_resets (
            token TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            expiresAt INTEGER NOT NULL,
            FOREIGN KEY (userId) REFERENCES users(id)
        )`);

        // Membership Types Table
        db.run(`CREATE TABLE IF NOT EXISTS membership_types (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            deprecated INTEGER DEFAULT 0
        )`);

        db.run('ALTER TABLE membership_types ADD COLUMN deprecated INTEGER DEFAULT 0', () => {});

        // User Memberships Table (many-to-many: one user can hold multiple membership types)
        db.run(`CREATE TABLE IF NOT EXISTS user_memberships (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            membershipType TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            membershipYear TEXT NOT NULL,
            UNIQUE (userId, membershipType, membershipYear),
            FOREIGN KEY (userId) REFERENCES users(id)
        )`);

        // Migration: add unique index to existing DBs and deduplicate rows first
        // (keep the row with the highest-priority status: active > pending > rejected)
        db.run(
            `
            DELETE FROM user_memberships
            WHERE id NOT IN (
                SELECT id FROM user_memberships AS um1
                WHERE id = (
                    SELECT id FROM user_memberships AS um2
                    WHERE um2.userId = um1.userId
                      AND um2.membershipType = um1.membershipType
                      AND um2.membershipYear = um1.membershipYear
                    ORDER BY
                        CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END ASC,
                        rowid DESC
                    LIMIT 1
                )
            )
        `,
            () => {
                // Create unique index after deduplication (safe to run even if already exists)
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_memberships_unique
                ON user_memberships (userId, membershipType, membershipYear)`);
            }
        );

        // Migrations: add new fields if updating existing DB
        db.run('ALTER TABLE users ADD COLUMN firstName TEXT', (err) => {
            if (!err) {
                // If we successfully added firstName, also try adding lastName and migrating data
                db.run('ALTER TABLE users ADD COLUMN lastName TEXT', () => {
                    db.all(
                        'SELECT id, name FROM users WHERE (firstName IS NULL OR firstName = "") AND name IS NOT NULL',
                        [],
                        (err3: Error | null, rows: UserNameRow[]) => {
                            if (!err3 && rows.length > 0) {
                                const stmt = db.prepare('UPDATE users SET firstName = ?, lastName = ? WHERE id = ?');
                                rows.forEach((row) => {
                                    const parts = (row.name || '').trim().split(' ');
                                    const f = parts[0] || '';
                                    const l = parts.slice(1).join(' ') || '';
                                    stmt.run([f, l, row.id]);
                                });
                                stmt.finalize();
                            }
                        }
                    );
                });
            }
        });
        db.run('ALTER TABLE users ADD COLUMN lastName TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN emergencyContactName TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN emergencyContactMobile TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN pronouns TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN dietaryRequirements TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN committeeRole TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN membershipYear TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN emailVerified INTEGER DEFAULT 0', () => {});
        db.run('ALTER TABLE users ADD COLUMN calendarToken TEXT', (err) => {
            // If the column was just added, populate existing users with tokens
            if (!err) {
                db.all<UserIdRow>('SELECT id FROM users WHERE calendarToken IS NULL', [], (err, rows) => {
                    if (!err && rows) {
                        const stmt = db.prepare('UPDATE users SET calendarToken = ? WHERE id = ?');
                        rows.forEach((row) => stmt.run([crypto.randomUUID(), row.id]));
                        stmt.finalize();
                    }
                });
            }
        });
        db.run('ALTER TABLE users ADD COLUMN instagram TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN faveCrag TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN bio TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN profilePhoto TEXT', () => {});

        // Sessions Table
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            date TEXT NOT NULL,
            capacity INTEGER NOT NULL,
            bookedSlots INTEGER DEFAULT 0,
            requiredMembership TEXT DEFAULT 'basic',
            visibility TEXT DEFAULT 'all',
            registrationVisibility TEXT DEFAULT 'all'
        )`);

        db.run('ALTER TABLE sessions ADD COLUMN requiredMembership TEXT DEFAULT "basic"', () => {});
        db.run('ALTER TABLE sessions ADD COLUMN visibility TEXT DEFAULT "all"', () => {});
        db.run('ALTER TABLE sessions ADD COLUMN registrationVisibility TEXT DEFAULT "all"', () => {});
        db.run('ALTER TABLE sessions ADD COLUMN location TEXT', () => {});

        // Bookings Table
        // reminderSentAt: epoch ms of last reminder sent (NULL = not yet reminded)
        db.run(`CREATE TABLE IF NOT EXISTS bookings (
            userId TEXT NOT NULL,
            sessionId TEXT NOT NULL,
            reminderSentAt INTEGER,
            PRIMARY KEY (userId, sessionId),
            FOREIGN KEY (userId) REFERENCES users(id),
            FOREIGN KEY (sessionId) REFERENCES sessions(id)
        )`);

        // Migration for pre-existing databases
        db.run('ALTER TABLE bookings ADD COLUMN reminderSentAt INTEGER', () => {});

        // Committee Roles Table (many-to-many: one user can hold multiple committee roles)
        db.run(`CREATE TABLE IF NOT EXISTS committee_roles (
            userId TEXT NOT NULL,
            role   TEXT NOT NULL,
            PRIMARY KEY (userId, role),
            FOREIGN KEY (userId) REFERENCES users(id)
        )`);

        // Migration: seed committee_roles from legacy committeeRole column
        db.run(`INSERT OR IGNORE INTO committee_roles (userId, role)
            SELECT id, committeeRole FROM users
            WHERE committeeRole IS NOT NULL AND committeeRole != ''`);

        // Candidates Table
        db.run(`CREATE TABLE IF NOT EXISTS candidates (
            userId TEXT PRIMARY KEY,
            manifesto TEXT NOT NULL,
            role TEXT NOT NULL,
            presentationLink TEXT,
            FOREIGN KEY (userId) REFERENCES users(id)
        )`);

        db.run('ALTER TABLE candidates ADD COLUMN role TEXT', () => {});
        db.run('ALTER TABLE candidates ADD COLUMN presentationLink TEXT', () => {});

        // System Config Table (for Elections open/close, etc.)
        db.run(`CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);

        // Votes Table
        db.run(`CREATE TABLE IF NOT EXISTS votes (
            userId TEXT PRIMARY KEY,
            candidateId TEXT NOT NULL,
            FOREIGN KEY (userId) REFERENCES users(id),
            FOREIGN KEY (candidateId) REFERENCES users(id)
        )`);

        // Referendums Table
        db.run(`CREATE TABLE IF NOT EXISTS referendums (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            createdAt INTEGER NOT NULL
        )`);

        // Referendum Votes Table
        db.run(`CREATE TABLE IF NOT EXISTS referendum_votes (
            userId TEXT NOT NULL,
            referendumId TEXT NOT NULL,
            choice TEXT NOT NULL, -- 'yes', 'no', 'abstain'
            PRIMARY KEY (userId, referendumId),
            FOREIGN KEY (userId) REFERENCES users(id),
            FOREIGN KEY (referendumId) REFERENCES referendums(id)
        )`);

        // Trips (docs/TRIPS_PLAN.md phase 1): outdoor meets as first-class
        // entities. status lifecycle: open | closed | cancelled | completed.
        // costBreakdown is a JSON blob ({ transport: 25, bunkhouse: 30 }); the
        // system tracks money as committee bookkeeping, never handles it.
        db.run(`CREATE TABLE IF NOT EXISTS trips (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            destination TEXT NOT NULL,
            description TEXT,
            startDate TEXT NOT NULL,
            endDate TEXT NOT NULL,
            meetupPoint TEXT,
            costBreakdown TEXT,
            totalCostPerPerson REAL NOT NULL,
            depositAmount REAL NOT NULL DEFAULT 0,
            capacity INTEGER NOT NULL,
            signupClosesAt TEXT NOT NULL,
            requiredMembership TEXT DEFAULT 'basic',
            visibility TEXT DEFAULT 'all',
            status TEXT NOT NULL DEFAULT 'open'
        )`);

        // Soft-cancelled signups keep payment history; UNIQUE blocks double signups.
        db.run(`CREATE TABLE IF NOT EXISTS trip_signups (
            id TEXT PRIMARY KEY,
            tripId TEXT NOT NULL REFERENCES trips(id),
            userId TEXT NOT NULL REFERENCES users(id),
            signedUpAt INTEGER NOT NULL,
            paymentStatus TEXT NOT NULL DEFAULT 'unpaid',
            paidAmount REAL NOT NULL DEFAULT 0,
            cancelledAt INTEGER,
            UNIQUE (tripId, userId)
        )`);

        // Gear Table
        db.run(`CREATE TABLE IF NOT EXISTS gear (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            totalQuantity INTEGER NOT NULL DEFAULT 1,
            availableQuantity INTEGER NOT NULL DEFAULT 1
        )`);

        // Gear Requests Table
        db.run(`CREATE TABLE IF NOT EXISTS gear_requests (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            gearId TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            requestDate TEXT NOT NULL,
            returnDate TEXT,
            FOREIGN KEY (userId) REFERENCES users(id),
            FOREIGN KEY (gearId) REFERENCES gear(id)
        )`);

        // Gallery Table
        db.run(`CREATE TABLE IF NOT EXISTS gallery (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            filepath TEXT NOT NULL,
            caption TEXT,
            uploadedBy TEXT,
            uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            featured INTEGER DEFAULT 0,
            featuredOrder INTEGER,
            heroDesktopX REAL DEFAULT 50,
            heroDesktopY REAL DEFAULT 50,
            heroDesktopZoom REAL DEFAULT 1,
            heroMobileX REAL DEFAULT 50,
            heroMobileY REAL DEFAULT 50,
            heroMobileZoom REAL DEFAULT 1,
            galleryLandscapeX REAL DEFAULT 50,
            galleryLandscapeY REAL DEFAULT 50,
            galleryLandscapeZoom REAL DEFAULT 1
        )`);
        db.run('ALTER TABLE gallery ADD COLUMN featured INTEGER DEFAULT 0', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN featuredOrder INTEGER', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN heroDesktopX REAL DEFAULT 50', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN heroDesktopY REAL DEFAULT 50', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN heroDesktopZoom REAL DEFAULT 1', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN heroMobileX REAL DEFAULT 50', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN heroMobileY REAL DEFAULT 50', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN heroMobileZoom REAL DEFAULT 1', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN galleryLandscapeX REAL DEFAULT 50', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN galleryLandscapeY REAL DEFAULT 50', () => {});
        db.run('ALTER TABLE gallery ADD COLUMN galleryLandscapeZoom REAL DEFAULT 1', () => {});

        // Create root admin if not exists
        db.get<RootUserRow>(
            'SELECT id, membershipYear FROM users WHERE email = ?',
            [ROOT_ADMIN_EMAIL],
            async (_err, row) => {
                if (!row) {
                // First boot for this database.
                // Production/beta must never start with a publicly-known credential, so generate a
                // one-off random password and print it exactly once (visible in container logs).
                // Rotate immediately after first login. Dev/test: stable DEV_ROOT_PASSWORD keeps
                // local logins and the backend test suite predictable.
                const isFirstBootInProd = process.env.NODE_ENV === 'production';
                const initialRootPassword = isFirstBootInProd
                    ? crypto.randomBytes(18).toString('base64url')
                    : DEV_ROOT_PASSWORD;
                const rootHash = await bcrypt.hash(initialRootPassword, 12);
                const currentYear = new Date().getFullYear();
                const currentMonth = new Date().getMonth();
                const membershipYear =
                    currentMonth < 8 ? `${currentYear - 1}/${currentYear}` : `${currentYear}/${currentYear + 1}`;

                db.run(
                    'INSERT INTO users (id, firstName, lastName, name, email, passwordHash, role, membershipStatus, membershipYear, calendarToken, emailVerified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        'user_root',
                        'Root',
                        'Admin',
                        'Root Admin',
                        ROOT_ADMIN_EMAIL,
                        rootHash,
                        'committee',
                        'active',
                        membershipYear,
                        crypto.randomUUID(),
                        1
                    ],
                    () => {
                        // Insert the active basic membership row for the root admin
                        db.run(
                            'INSERT OR IGNORE INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
                            ['umem_root', 'user_root', 'basic', 'active', membershipYear]
                        );
                    }
                );
                console.log('Root admin created.');
                if (isFirstBootInProd) {
                    console.log(
                        `=== ROOT ADMIN FIRST-TIME PASSWORD for ${ROOT_ADMIN_EMAIL} (rotate immediately): ${initialRootPassword} ===`
                    );
                }
            } else {
                // Ensure existing root admin is always marked as active + verified
                db.run('UPDATE users SET emailVerified = 1, membershipStatus = ? WHERE email = ?', [
                    'active',
                    ROOT_ADMIN_EMAIL
                ]);
                // In non-production, keep local root credentials stable for troubleshooting/dev access
                if (process.env.NODE_ENV !== 'production') {
                    const rootHash = await bcrypt.hash(DEV_ROOT_PASSWORD, 12);
                    db.run(
                        'UPDATE users SET passwordHash = ?, role = ?, firstName = ?, lastName = ?, name = ? WHERE email = ?',
                        [rootHash, 'committee', 'Root', 'Admin', 'Root Admin', ROOT_ADMIN_EMAIL]
                    );
                }
                // Upgrade any existing basic memberships to active (avoids pending+active duplicates)
                db.run(
                    'UPDATE user_memberships SET status = ? WHERE userId = ? AND membershipType = ?',
                    ['active', 'user_root', 'basic'],
                    function (this: RunResult) {
                        // If no rows were updated, insert a fresh active row
                        if (this.changes === 0) {
                            const currentYear = new Date().getFullYear();
                            const currentMonth = new Date().getMonth();
                            const membershipYear =
                                currentMonth < 8
                                    ? `${currentYear - 1}/${currentYear}`
                                    : `${currentYear}/${currentYear + 1}`;
                            db.run(
                                'INSERT OR IGNORE INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
                                ['umem_root', 'user_root', 'basic', 'active', row.membershipYear || membershipYear]
                            );
                        }
                    }
                );
                }
            }
        );

        // Available Committee Roles Table
        db.run(`CREATE TABLE IF NOT EXISTS available_roles (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL
        )`);

        // Seed default available roles if table is empty
        db.get<CountRow>('SELECT COUNT(*) as count FROM available_roles', (err, row) => {
            if (row && row.count === 0) {
                console.log('Seeding default available roles...');
                const defaultRoles = [
                    ['Chair', 'Chair'],
                    ['Secretary', 'Secretary'],
                    ['Treasurer', 'Treasurer'],
                    ['Indoor & Competitions', 'Indoor & Competitions'],
                    ['Welfare & Inclusions', 'Welfare & Inclusions'],
                    ['Team Captain', 'Team Captain'],
                    ['Social Sec', 'Social Sec'],
                    ["Women's Captain", "Women's Captain"],
                    ["Men's Captain", "Men's Captain"],
                    ['Publicity', 'Publicity'],
                    ['Kit & Safety Sec', 'Kit & Safety Sec']
                ];
                const stmt = db.prepare('INSERT INTO available_roles (id, label) VALUES (?, ?)');
                defaultRoles.forEach((r) => stmt.run(r));
                stmt.finalize();
            }
        });

        // Seed default config
        db.get<ConfigRow>('SELECT value FROM config WHERE key = ?', ['electionsOpen'], (err, row) => {
            if (!row) {
                db.run('INSERT INTO config (key, value) VALUES (?, ?)', ['electionsOpen', 'false']);
            }
        });

        // Session Types Table
        db.run(`CREATE TABLE IF NOT EXISTS session_types (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL
        )`);

        // Seed default session types if table is empty
        db.get<CountRow>('SELECT COUNT(*) as count FROM session_types', (err, row) => {
            if (row && row.count === 0) {
                console.log('Seeding default session types...');
                const defaultTypes = [
                    ['Competition', 'Competition'],
                    ['Social', 'Social'],
                    ['Training Session (Bouldering)', 'Training Session (Bouldering)'],
                    ['Training Session (Roped)', 'Training Session (Roped)'],
                    ['Meeting', 'Meeting']
                ];
                const stmt = db.prepare('INSERT INTO session_types (id, label) VALUES (?, ?)');
                defaultTypes.forEach((t) => stmt.run(t));
                stmt.finalize();
            }
        });

        // Seed default membership types if table is empty
        db.get<CountRow>('SELECT COUNT(*) as count FROM membership_types', (err, row) => {
            if (row && row.count === 0) {
                console.log('Seeding default membership types...');
                const defaultMembershipTypes = [
                    ['basic', 'Basic Membership (All Members)'],
                    ['bouldering', 'Bouldering Add-on'],
                    ['comp_team', 'Competition Team Only']
                ];
                const stmt = db.prepare('INSERT INTO membership_types (id, label) VALUES (?, ?)');
                defaultMembershipTypes.forEach((t) => stmt.run(t));
                stmt.finalize();
            }
        });

        // Seed default sessions if table is empty
        db.get<CountRow>('SELECT COUNT(*) as count FROM sessions', (err, row) => {
            if (row && row.count === 0) {
                console.log('Seeding default sessions...');
                const currentYear = new Date().getFullYear();
                const currentMonth = new Date().getMonth() + 1;
                const pad = (n: number) => n.toString().padStart(2, '0');

                const defaultSessions = [
                    [
                        'sess_1',
                        'Squad',
                        'Advanced Lead Training',
                        `${currentYear}-${pad(currentMonth)}-14T19:00:00`,
                        15,
                        15,
                        'comp_team'
                    ],
                    [
                        'sess_2',
                        'Social',
                        'Friday Night Bouldering',
                        `${currentYear}-${pad(currentMonth)}-16T18:00:00`,
                        40,
                        28,
                        'basic'
                    ],
                    [
                        'sess_3',
                        'Rope',
                        'Beginner Top Rope',
                        `${currentYear}-${pad(currentMonth)}-18T14:00:00`,
                        12,
                        12,
                        'basic'
                    ],
                    [
                        'sess_4',
                        'Squad',
                        'NUBS Prep Simulator',
                        `${currentYear}-${pad(currentMonth)}-21T17:30:00`,
                        20,
                        18,
                        'comp_team'
                    ],
                    [
                        'sess_5',
                        'Social',
                        'Pub + Board Games',
                        `${currentYear}-${pad(currentMonth)}-23T20:00:00`,
                        50,
                        45,
                        'basic'
                    ],
                    [
                        'sess_6',
                        'Rope',
                        'Lead Belay Course',
                        `${currentYear}-${pad(currentMonth)}-25T13:00:00`,
                        8,
                        4,
                        'basic'
                    ]
                ];

                const stmt = db.prepare(
                    'INSERT INTO sessions (id, type, title, date, capacity, bookedSlots, requiredMembership) VALUES (?, ?, ?, ?, ?, ?, ?)'
                );
                defaultSessions.forEach((s) => stmt.run(s));
                stmt.finalize();
            }
        });

        // Seed default gear if table is empty
        db.get<CountRow>('SELECT COUNT(*) as count FROM gear', (err, row) => {
            if (row && row.count === 0) {
                console.log('Seeding default gear...');
                const defaultGear = [
                    ['gear_1', 'Petzl Corax Harness (Size M)', 'Versatile and easy to use harness', 5, 5],
                    ['gear_2', 'Black Diamond Momentum Harness (Size L)', 'Comfortable all-around harness', 3, 3],
                    ['gear_3', 'Petzl Boreo Helmet', 'Durable helmet for all climbing styles', 10, 10],
                    ['gear_4', 'DMM Bug Belay Device', 'Classic ATC style belay device with carabiner', 8, 8]
                ];

                const stmt = db.prepare(
                    'INSERT INTO gear (id, name, description, totalQuantity, availableQuantity) VALUES (?, ?, ?, ?, ?)'
                );
                defaultGear.forEach((g) => stmt.run(g));
                stmt.finalize();
            }
        });
    });
}
