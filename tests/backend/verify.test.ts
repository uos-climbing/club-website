import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../backend/server';
import { db } from '../../backend/db';

describe('Verification API', () => {
    const CALENDAR_TOKEN = 'test-token-123';

    beforeAll(async () => {
        // Wait for DB initialization
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Create a test user with a specific calendar token
        await request(app).post('/api/auth/register').send({
            firstName: 'Verify',
            lastName: 'Me',
            email: 'verify@example.com',
            password: 'Password123!',
            passwordConfirm: 'Password123!',
            registrationNumber: 'VER1'
        });

        // Update the user to have a known calendar token and active status
        await new Promise<void>((resolve, reject) => {
            db.run(
                'UPDATE users SET calendarToken = ?, membershipStatus = ?, membershipYear = ? WHERE email = ?',
                [CALENDAR_TOKEN, 'active', '2025/26', 'verify@example.com'],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    });

    afterAll(async () => {
        db.close();
    });

    it('should verify a member by calendar token', async () => {
        const res = await request(app).get(`/api/verify/${CALENDAR_TOKEN}`);

        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Verify Me');
        expect(res.body.status).toBe('active');
        expect(res.body.isActive).toBe(true);
        expect(res.body.expiryDate).toBe('31 Aug 2026');
    });

    it('should return 404 for an unknown token', async () => {
        const res = await request(app).get('/api/verify/unknown-token');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Member not found');
    });

    it('should handle legacy verification via registration number in test mode', async () => {
        const res = await request(app).get('/api/verify/VER1');

        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Verify Me');
    });

    it('should handle legacy verification via user ID in test mode', async () => {
        // Get the user ID first
        const userRes = await new Promise<any>((resolve, reject) => {
            db.get('SELECT id FROM users WHERE email = ?', ['verify@example.com'], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        const res = await request(app).get(`/api/verify/${userRes.id}`);
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Verify Me');
    });

    it('should handle database errors', async () => {
        const { vi } = await import('vitest');
        const spy = vi.spyOn(db, 'get').mockImplementationOnce((query, params, cb) => cb(new Error('DB Error'), null));

        const res = await request(app).get(`/api/verify/${CALENDAR_TOKEN}`);
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Database error');

        spy.mockRestore();
    });

    it('should handle malformed membershipYear', async () => {
        await new Promise<void>((resolve) => {
            db.run('UPDATE users SET membershipYear = ? WHERE email = ?', ['invalid', 'verify@example.com'], () =>
                resolve()
            );
        });

        const res = await request(app).get(`/api/verify/${CALENDAR_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.expiryDate).toBe('N/A');

        // Reset for other tests if any
        await new Promise<void>((resolve) => {
            db.run('UPDATE users SET membershipYear = ? WHERE email = ?', ['2025/26', 'verify@example.com'], () =>
                resolve()
            );
        });
    });

    it('should format full second year in membershipYear correctly', async () => {
        await new Promise<void>((resolve) => {
            db.run('UPDATE users SET membershipYear = ? WHERE email = ?', ['2025/2026', 'verify@example.com'], () =>
                resolve()
            );
        });

        const res = await request(app).get(`/api/verify/${CALENDAR_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.expiryDate).toBe('31 Aug 2026');

        await new Promise<void>((resolve) => {
            db.run('UPDATE users SET membershipYear = ? WHERE email = ?', ['2025/26', 'verify@example.com'], () =>
                resolve()
            );
        });
    });
});
