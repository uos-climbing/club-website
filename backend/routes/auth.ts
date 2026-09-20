import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { dbGet, dbAll, dbRun } from '../utils/db';
import { SECRET_KEY } from '../config';
import { authenticateToken } from '../middleware/auth';
import { sendEmail } from '../services/email';
import { getAcademicYear, isSheffieldEmail } from './auth.helpers';
import { getMembershipTypeIdsAsync } from '../services/membership';

const IS_TEST = process.env.NODE_ENV === 'test';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const AUTH_RATE_LIMIT_ENABLED = process.env.AUTH_RATE_LIMIT_ENABLED === 'true';
const ROOT_ADMIN_EMAIL = (process.env.ROOT_ADMIN_EMAIL || 'committee@sheffieldclimbing.org').toLowerCase();

// Create the limiter once at module init — express-rate-limit forbids per-request creation
const _rateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false
});

const authLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Keep local development usable by default; enable explicitly via AUTH_RATE_LIMIT_ENABLED=true
    if (IS_TEST || (!IS_PRODUCTION && !AUTH_RATE_LIMIT_ENABLED)) return next();
    return _rateLimiter(req, res, next);
};

const router = express.Router();

const cookieOptions = {
    httpOnly: true,
    secure:
        process.env.COOKIE_SECURE === 'true' ||
        (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false'),
    sameSite: 'strict' as const,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
};

/** Promisified wrapper for the callback-style membership service */
function generateOTP(): string {
    return crypto.randomInt(100000, 999999).toString();
}

router.post('/register', authLimiter, async (req, res) => {
    const { firstName, lastName, email, registrationNumber, password, passwordConfirm, membershipTypes } = req.body;
    const normalizedEmail = (email || '').toString().trim().toLowerCase();
    const normalizedRegistrationNumber = (registrationNumber || '').toString().trim();

    if (!firstName || !lastName || !normalizedEmail || !password || !passwordConfirm || !normalizedRegistrationNumber) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (password !== passwordConfirm) {
        return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 12) {
        return res.status(400).json({ error: 'Password must be at least 12 characters long' });
    }

    try {
        const membershipTypeIds = await getMembershipTypeIdsAsync();

        const defaultMembership = membershipTypeIds.includes('basic') ? 'basic' : membershipTypeIds[0];
        if (!defaultMembership) {
            return res.status(500).json({ error: 'No membership types configured' });
        }

        // Validate & default membership types
        let types: string[] =
            Array.isArray(membershipTypes) && membershipTypes.length > 0
                ? membershipTypes.filter((t: string) => membershipTypeIds.includes(t))
                : [defaultMembership];
        if (types.length === 0) types = [defaultMembership];

        const preApproved: any = await dbGet(
            'SELECT registrationNumber, membershipYear FROM preapproved_members WHERE registrationNumber = ?',
            [normalizedRegistrationNumber]
        );

        const passwordHash = await bcrypt.hash(password, 12);
        const id = 'user_' + crypto.randomUUID();

        let role = 'member';
        let membershipStatus = 'pending';
        if (!IS_TEST && !isSheffieldEmail(normalizedEmail)) {
            return res.status(400).json({ error: 'Please register with your @sheffield.ac.uk email address.' });
        }
        const isRootAdminTestBypass = IS_TEST && normalizedEmail === ROOT_ADMIN_EMAIL;
        if (isRootAdminTestBypass) {
            role = 'committee';
            membershipStatus = 'active';
        }

        let membershipYear = getAcademicYear();
        if (preApproved?.membershipYear) {
            membershipStatus = 'active';
            membershipYear = preApproved.membershipYear;
        }

        const calendarToken = crypto.randomUUID();
        // In test env, mark as verified immediately
        const emailVerified = IS_TEST || isRootAdminTestBypass ? 1 : 0;

        try {
            await dbRun(
                'INSERT INTO users (id, firstName, lastName, name, email, passwordHash, registrationNumber, role, membershipStatus, membershipYear, calendarToken, emailVerified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    id,
                    firstName,
                    lastName,
                    `${firstName} ${lastName}`,
                    normalizedEmail,
                    passwordHash,
                    normalizedRegistrationNumber,
                    role,
                    membershipStatus,
                    membershipYear,
                    calendarToken,
                    emailVerified
                ]
            );
        } catch (err: any) {
            if (err?.message?.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'Email already exists' });
            }
            console.error('Register database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        const membershipRowStatus = IS_TEST || preApproved || isRootAdminTestBypass ? 'active' : 'pending';
        for (const t of types) {
            await dbRun(
                'INSERT INTO user_memberships (id, userId, membershipType, status, membershipYear) VALUES (?, ?, ?, ?, ?)',
                ['umem_' + crypto.randomUUID(), id, t, membershipRowStatus, membershipYear]
            );
        }

        if (preApproved) {
            await dbRun('DELETE FROM preapproved_members WHERE registrationNumber = ?', [normalizedRegistrationNumber]);
        }

        const user = {
            id,
            firstName,
            lastName,
            email: normalizedEmail,
            registrationNumber: normalizedRegistrationNumber,
            role,
            committeeRole: null,
            membershipStatus,
            membershipYear,
            calendarToken
        };

        if (IS_TEST || isRootAdminTestBypass) {
            // In test environment: skip email verification, return token immediately
            const token = jwt.sign(user, SECRET_KEY, { expiresIn: '24h' });
            res.cookie('uscc_token', token, cookieOptions);
            return res.json({ user, token });
        }

        // Production/dev: send OTP, do not return a token yet
        const otp = generateOTP();
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

        try {
            await dbRun('INSERT OR REPLACE INTO email_verifications (userId, code, expiresAt) VALUES (?, ?, ?)', [
                id,
                otp,
                expiresAt
            ]);
        } catch (otpErr) {
            console.error('Failed to store verification code:', otpErr);
            return res.status(500).json({ error: 'Failed to create verification code' });
        }

        // Send verification email (fire-and-forget)
        sendEmail(
            normalizedEmail,
            'Verify your USMC email address',
            `Hi ${firstName},\n\nYour verification code is: ${otp}\n\nThis code expires in 15 minutes.\n\nIf you did not register for University of Sheffield Mountaineering & Climbing Club (USMC), please ignore this email.`,
            `<p>Hi ${firstName},</p><p>Your verification code is:</p><h2 style="letter-spacing:8px;font-size:32px;">${otp}</h2><p>This code expires in 15 minutes.</p><p style="color:#999;font-size:12px;">If you did not register for University of Sheffield Mountaineering &amp; Climbing Club (USMC), please ignore this email.</p>`
        ).catch((e) => console.error('Failed to send verification email:', e));

        return res.json({ pendingVerification: true, userId: id });
    } catch (err) {
        console.error('Register failed:', err);
        return res.status(500).json({ error: 'Server error' });
    }
});

router.post('/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = (email || '').toString().trim().toLowerCase();

    if (!normalizedEmail || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await dbGet<any>('SELECT * FROM users WHERE email = ?', [normalizedEmail]).catch((err) => {
        console.error('Login database error:', err);
        return null;
    });

    if (user === null) {
        return res.status(500).json({ error: 'Database error' });
    }
    if (!user) {
        console.warn(`Login failed: user not found for email "${normalizedEmail}"`);
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
        console.warn(`Login failed: incorrect password for email "${normalizedEmail}"`);
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Block login if email is not verified (unless test env)
    if (!IS_TEST && !user.emailVerified) {
        return res.status(403).json({
            error: 'Email not verified. Please check your inbox for a verification code.',
            pendingVerification: true,
            userId: user.id
        });
    }

    // Don't send hash back
    const { passwordHash, ...userWithoutPassword } = user;
    void passwordHash;
    const token = jwt.sign(userWithoutPassword, SECRET_KEY, { expiresIn: '24h' });

    res.cookie('uscc_token', token, cookieOptions);
    res.json({ user: userWithoutPassword, token });
});

/** Verify a user's email with their OTP code */
router.post('/verify-email', authLimiter, async (req, res) => {
    const { userId, code } = req.body;

    if (!userId || !code) {
        return res.status(400).json({ error: 'Missing userId or code' });
    }

    const row = await dbGet<any>('SELECT * FROM email_verifications WHERE userId = ?', [userId]).then(
        (r) => r ?? null,
        (err) => {
            console.error('verify-email database error:', err);
            return 'DB_ERROR';
        }
    );
    if (row === 'DB_ERROR') return res.status(500).json({ error: 'Database error' });
    if (!row) return res.status(400).json({ error: 'Invalid or expired code' });
    if (row.code !== code.trim()) return res.status(400).json({ error: 'Invalid or expired code' });
    if (Date.now() > row.expiresAt) return res.status(400).json({ error: 'Invalid or expired code' });

    const updated = await dbRun('UPDATE users SET emailVerified = 1 WHERE id = ?', [userId]).catch(() => null);
    if (updated === null) return res.status(500).json({ error: 'Database error' });

    await dbRun('DELETE FROM email_verifications WHERE userId = ?', [userId]).catch(() => {});

    // Fetch the full user to sign the JWT
    const user = await dbGet<any>(
        'SELECT id, firstName, lastName, email, registrationNumber, role, committeeRole, membershipStatus, membershipYear, calendarToken FROM users WHERE id = ?',
        [userId]
    ).catch((err) => {
        console.error('verify-email user fetch failed:', err);
        return null;
    });
    if (!user) return res.status(500).json({ error: 'Database error' });

    // Send welcome email now that they've verified
    sendEmail(
        user.email,
        'Welcome to USMC!',
        `Hi ${user.firstName},\n\nWelcome to University of Sheffield Mountaineering & Climbing Club (USMC)! Your email has been verified and your registration is complete.`,
        `<p>Hi ${user.firstName},</p><p>Welcome to University of Sheffield Mountaineering &amp; Climbing Club (USMC)! Your email has been verified and your registration is complete.</p>`
    ).catch((e) => console.error('Failed to send welcome email:', e));

    const token = jwt.sign(user, SECRET_KEY, { expiresIn: '24h' });
    res.cookie('uscc_token', token, cookieOptions);
    res.json({ user, token });
});

/** Re-send a verification OTP to the user */
router.post('/request-verification', authLimiter, async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    const user = await dbGet<any>('SELECT id, firstName, lastName, email, emailVerified FROM users WHERE id = ?', [
        userId
    ]).then(
        (u) => u ?? null,
        (err) => {
            console.error('request-verification database error:', err);
            return 'DB_ERROR';
        }
    );
    if (user === 'DB_ERROR') return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.emailVerified) {
        return res.status(400).json({ error: 'Email is already verified' });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + 15 * 60 * 1000;

    try {
        await dbRun('INSERT OR REPLACE INTO email_verifications (userId, code, expiresAt) VALUES (?, ?, ?)', [
            user.id,
            otp,
            expiresAt
        ]);
    } catch (err) {
        console.error('Failed to store verification code:', err);
        return res.status(500).json({ error: 'Database error' });
    }

    sendEmail(
        user.email,
        'Your new USMC verification code',
        `Hi ${user.firstName},\n\nYour new verification code is: ${otp}\n\nThis code expires in 15 minutes.`,
        `<p>Hi ${user.firstName},</p><p>Your new verification code is:</p><h2 style="letter-spacing:8px;font-size:32px;">${otp}</h2><p>This code expires in 15 minutes.</p>`
    ).catch((e) => console.error('Failed to send verification email:', e));

    res.json({ success: true });
});

/**
 * Forgot Password — generates a reset token and emails a link.
 * Always returns 200 regardless of whether the email exists (prevents enumeration).
 */
router.post('/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Always respond 200 first to prevent email enumeration
    res.json({ success: true, message: 'If that email is registered, you will receive a reset link shortly.' });

    // Background processing — response already sent above.
    try {
        const user = await dbGet<any>('SELECT id, firstName, lastName, email FROM users WHERE email = ?', [email]);
        if (!user) return;

        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

        await dbRun('INSERT OR REPLACE INTO password_resets (token, userId, expiresAt) VALUES (?, ?, ?)', [
            token,
            user.id,
            expiresAt
        ]);

        const appUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
        const baseUrl = appUrl || (IS_PRODUCTION ? '' : 'http://localhost:5173');
        if (!baseUrl) {
            console.error('APP_URL is required in production for password reset links.');
            return;
        }
        const resetLink = `${baseUrl}/login.html?reset_token=${token}`;

        sendEmail(
            user.email,
            'Reset your USMC password',
            `Hi ${user.firstName},\n\nClick the link below to reset your password (expires in 15 minutes):\n\n${resetLink}\n\nIf you did not request a password reset, please ignore this email.`,
            `<p>Hi ${user.firstName},</p><p>Click the button below to reset your password. This link expires in <strong>15 minutes</strong>.</p><p style="text-align:center;margin:32px 0;"><a href="${resetLink}" style="background:#fdb913;color:#1a1a2e;padding:14px 28px;border-radius:8px;font-weight:900;text-decoration:none;letter-spacing:1px;font-size:14px;">Reset Password</a></p><p style="color:#999;font-size:12px;">If you did not request a password reset, please ignore this email.</p>`
        ).catch((e) => console.error('Failed to send reset email:', e));
    } catch (err) {
        // Silently ignore background failures — enumeration-safe contract means
        // we must never leak whether an account exists through error responses.
        console.warn('Forgot-password background processing skipped:', err instanceof Error ? err.message : err);
    }
});

/** Reset Password — exchange a valid token for a new password */
router.post('/reset-password', authLimiter, async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
        return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (newPassword.length < 12) {
        return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }

    const row = await dbGet<any>('SELECT * FROM password_resets WHERE token = ?', [token]).then(
        (r) => r ?? null,
        () => null
    );
    // Original treated query failures the same as missing tokens (enumeration-safe)
    if (!row) return res.status(400).json({ error: 'Invalid or expired reset token' });

    if (Date.now() > row.expiresAt) {
        await dbRun('DELETE FROM password_resets WHERE token = ?', [token]);
        return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    try {
        const newHash = await bcrypt.hash(newPassword, 12);
        const updated = await dbRun('UPDATE users SET passwordHash = ? WHERE id = ?', [newHash, row.userId]).catch(
            () => null
        );
        if (updated === null) return res.status(500).json({ error: 'Database error' });
        await dbRun('DELETE FROM password_resets WHERE token = ?', [token]);
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/logout', (req, res) => {
    res.clearCookie('uscc_token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    });
    res.json({ success: true });
});

router.get('/me', authenticateToken, async (req: any, res) => {
    const user = await dbGet<any>(
        'SELECT id, firstName, lastName, name, email, registrationNumber, role, committeeRole, membershipStatus, membershipYear, emergencyContactName, emergencyContactMobile, pronouns, dietaryRequirements, calendarToken, instagram, faveCrag, bio, profilePhoto FROM users WHERE id = ?',
        [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.name = user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;

    const roles = await dbAll<{ role: string }>('SELECT role FROM committee_roles WHERE userId = ?', [
        req.user.id
    ]).catch(() => [] as { role: string }[]);

    user.committeeRoles = Array.isArray(roles) ? roles.map((r) => r.role) : [];
    res.json({ user });
});

export default router;
