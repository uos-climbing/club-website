import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const BETA_ACCESS_COOKIE = 'BETA_ACCESS_TOKEN';

export const betaGate = (req: Request, res: Response, next: NextFunction) => {
    // Only apply if IS_BETA is enabled
    if (process.env.IS_BETA !== 'true') {
        return next();
    }

    // Allow access to auth API and the gate page itself
    const publicPaths = ['/api/auth', '/api/beta-auth', '/api/csp-report', '/api/health', '/beta-gate', '/favicon.ico'];
    if (publicPaths.some((path) => req.path.startsWith(path))) {
        return next();
    }

    // Check for access token in cookies
    const token = req.cookies[BETA_ACCESS_COOKIE];

    if (!token) {
        return res.redirect('/beta-gate');
    }

    // No fallback secret: config.ts fails fast at boot when IS_BETA=true without
    // BETA_ACCESS_SECRET, so this branch only trips on a badly mutated runtime environment.
    // Read per-request (not bound at module load) so tests can configure the env dynamically.
    const secret = process.env.BETA_ACCESS_SECRET;
    if (!secret) {
        return res.status(500).send('Beta access is not configured');
    }

    try {
        jwt.verify(token, secret);
        next();
    } catch {
        // Token invalid or expired
        res.clearCookie(BETA_ACCESS_COOKIE);
        res.redirect('/beta-gate');
    }
};
