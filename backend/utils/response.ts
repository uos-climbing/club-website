import { Response } from 'express';

export function standardDbResponse<T = { success: true }>(res: Response, successPayload: T = { success: true } as T) {
    return function (err: Error | null) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(successPayload);
    };
}
