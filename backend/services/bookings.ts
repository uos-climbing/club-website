import { dbAll, dbRun } from '../utils/db';
import { sendEmail } from './email';

const BASE_URL = (process.env.APP_URL || '').trim().replace(/\/+$/, '') || 'http://localhost:5173';

type ReminderRow = {
    sid: string;
    uid: string;
    email: string;
    firstName: string | null;
    title: string;
    type: string;
    date: string;
    location: string | null;
};

function formatSessionDate(isoDate: string): string {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return isoDate;
    return d.toLocaleString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/London'
    });
}

export async function sendBookingConfirmation(
    email: string,
    firstName: string,
    session: { title: string; type: string; date: string; location?: string | null }
): Promise<void> {
    const when = formatSessionDate(session.date);
    const where = session.location ? `\nLocation: ${session.location}` : '';
    await sendEmail(
        email,
        `Booking confirmed: ${session.title}`,
        `Hi ${firstName},\n\nYour place is booked.\n\nSession: ${session.title} (${session.type})\nWhen: ${when}${where}\n\nManage your bookings: ${BASE_URL}/schedule`,
        `<p>Hi ${firstName},</p><p>Your place is <strong>booked</strong>.</p><p><strong>${session.title}</strong> (${session.type})<br>When: ${when}${session.location ? `<br>Where: ${session.location}` : ''}</p><p style="color:#999;font-size:12px;">Manage bookings on the club schedule page.</p>`
    ).catch((e) => console.error('Failed to send booking confirmation:', e));
}

export async function sendCancellationConfirmation(
    email: string,
    firstName: string,
    session: { title: string }
): Promise<void> {
    await sendEmail(
        email,
        `Booking cancelled: ${session.title}`,
        `Hi ${firstName},\n\nYour booking for "${session.title}" has been cancelled and your place released.`,
        `<p>Hi ${firstName},</p><p>Your booking for <strong>${session.title}</strong> has been cancelled and your place released.</p>`
    ).catch((e) => console.error('Failed to send cancellation confirmation:', e));
}

/**
 * Send reminders for sessions starting within the next `windowHours`.
 * A booking is reminded at most once (reminderSentAt guard, set in the same
 * transaction as the check so concurrent runs cannot double-send).
 *
 * Returns the number of reminders sent. Designed to be called periodically;
 * errors are logged per-session rather than aborting the whole batch.
 */
export async function processBookingReminders(windowHours = 24, now = Date.now()): Promise<number> {
    const horizon = now + windowHours * 3600 * 1000;

    let rows: ReminderRow[];
    try {
        rows = await dbAll<ReminderRow>(
            `SELECT b.sessionId AS sid, b.userId AS uid,
                    u.email, u.firstName,
                    s.title, s.type, s.date, s.location
             FROM bookings b
             JOIN sessions s ON s.id = b.sessionId
             JOIN users u ON u.id = b.userId
             WHERE b.reminderSentAt IS NULL`
        );
    } catch (err) {
        console.error('Reminder query failed:', err);
        return 0;
    }

    let sent = 0;
    for (const row of rows) {
        const start = new Date(row.date).getTime();
        if (Number.isNaN(start) || start <= now || start > horizon) continue;

        // Claim first (atomic conditional update), then send — a crash between
        // claim and send loses one reminder, but can never double-send.
        // Persist the injected `now`, not wall-clock: keeps the function
        // deterministic when callers pass a fixed time (tests).
        try {
            await dbRun(
                'UPDATE bookings SET reminderSentAt = ? WHERE sessionId = ? AND userId = ? AND reminderSentAt IS NULL',
                [now, row.sid, row.uid]
            );
            await sendEmail(
                row.email,
                `Reminder: ${row.title}`,
                `Hi ${row.firstName ?? 'there'},\n\nReminder that you're booked for:\n${row.title} (${row.type})\nWhen: ${formatSessionDate(row.date)}${row.location ? `\nLocation: ${row.location}` : ''}\n\nIf you can no longer make it, please cancel on the schedule page so someone else can take the spot.`,
                `<p>Hi ${row.firstName ?? 'there'},</p><p>You're booked for <strong>${row.title}</strong> (${row.type}).<br>When: ${formatSessionDate(row.date)}${row.location ? `<br>Where: ${row.location}` : ''}</p><p style="color:#999;font-size:12px;">If you can't make it, cancel on the schedule page so someone else can take the spot.</p>`
            );
            sent++;
        } catch (err) {
            console.error(`Reminder failed for session ${row.sid} / user ${row.uid}:`, err);
        }
    }

    if (sent > 0) console.log(`[reminders] sent ${sent}`);
    return sent;
}

/** Hourly in-process scheduler (no-op under test runners). */
export function startReminderScheduler(): void {
    if (process.env.NODE_ENV === 'test') return;
    setInterval(
        () => {
            void processBookingReminders(24);
        },
        60 * 60 * 1000
    ).unref?.();
}
