import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { SECRET_KEY } from '../config';
import { dbGet } from '../utils/db';

const ROOT_ADMIN_EMAIL = (process.env.ROOT_ADMIN_EMAIL || 'committee@sheffieldclimbing.org').toLowerCase();

export interface AuthTokenPayload extends jwt.JwtPayload {
    id: string;
    email: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    role: string;
    committeeRole?: string | null;
    committeeRoles?: string[];
}

// Express intentionally exposes request augmentation through a namespace.
/* eslint-disable @typescript-eslint/no-namespace */
declare global {
    namespace Express {
        interface Request {
            user?: AuthTokenPayload;
        }
    }
}
/* eslint-enable @typescript-eslint/no-namespace */

function getToken(req: Request): string | undefined {
    const cookieToken = req.cookies?.uscc_token;
    if (typeof cookieToken === 'string') return cookieToken;

    const authHeader = req.get('authorization');
    return authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
}

function hasAuthUser(req: Request, res: Response): req is Request & { user: AuthTokenPayload } {
    if (req.user) return true;
    res.status(401).json({ error: 'Unauthorized' });
    return false;
}

// Middleware to verify JWT
export const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, SECRET_KEY, (err: jwt.VerifyErrors | null, decoded: string | jwt.JwtPayload | undefined) => {
        if (
            err ||
            !decoded ||
            typeof decoded === 'string' ||
            typeof decoded.id !== 'string' ||
            typeof decoded.email !== 'string' ||
            typeof decoded.role !== 'string'
        ) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        req.user = decoded as AuthTokenPayload;
        next();
    });
};

export const requireCommittee = async (req: Request, res: Response, next: NextFunction) => {
    if (!hasAuthUser(req, res)) return;
    // The root account cannot be demoted. Retaining this fast path also keeps
    // authorization available if a transient database failure affects an admin.
    const isRootAdmin = req.user.role === 'committee' && (req.user.email || '').toLowerCase() === ROOT_ADMIN_EMAIL;
    if (isRootAdmin) return next();

    // Committee status is mutable, so use the database as the source of truth.
    // This also admits members promoted since their current JWT was issued.
    // Any database error denies access rather than silently trusting stale data.
    const user = await dbGet<{ id: string }>(
        'SELECT id FROM users WHERE id = ? AND (role = "committee" OR committeeRole IS NOT NULL)',
        [req.user.id]
    ).catch(() => undefined);
    if (user) return next();

    const junctionRow = await dbGet('SELECT userId FROM committee_roles WHERE userId = ? LIMIT 1', [req.user.id]).catch(
        () => undefined
    );
    if (junctionRow) return next();

    res.status(403).json({ error: 'Requires committee privileges' });
};

export const requireKitSec = async (req: Request, res: Response, next: NextFunction) => {
    if (!hasAuthUser(req, res)) return;

    // Fetch the latest role fields from DB in case the token is stale.
    const user = await dbGet<{ role: string; committeeRole: string | null; email: string }>(
        'SELECT role, committeeRole, email FROM users WHERE id = ?',
        [req.user.id]
    ).catch(() => undefined);
    if (!user) return res.status(403).json({ error: 'Unauthorized' });

    // Root admin or Kit & Safety Sec can pass
    const isRootAdmin = user.role === 'committee' && (user.email || '').toLowerCase() === ROOT_ADMIN_EMAIL;
    if (isRootAdmin || user.committeeRole === 'Kit & Safety Sec') return next();

    res.status(403).json({ error: 'Requires Kit & Safety Sec privileges' });
};
