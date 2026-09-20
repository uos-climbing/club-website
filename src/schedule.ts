import './style.css';
import { authState, getCurrentAcademicYear } from './auth';
import { renderCalendarEvents } from './calendar';
import { openSessionModal } from './components/sessionModal';
import { initApp } from './main';
import { apiFetch } from './lib/api/http';

export async function initJoinApp() {
    // 1. Initialize Layout (Navbar & Footer)
    initApp();

    const academicYearDisplay = document.getElementById('academic-year-display');
    if (academicYearDisplay) {
        academicYearDisplay.textContent = getCurrentAcademicYear() + ' academic year';
    }

    // 2. Initialize Auth State (in case user is logged in, though join page is semi-public)
    await authState.init();

    // 2. Fetch Sessions
    const sessionsGrid = document.getElementById('calendar-grid');
    const calendarLegend = document.getElementById('calendar-legend');
    const monthDisplay = document.getElementById('calendar-month-display');
    const prevMonthBtn = document.getElementById('prev-month-btn');
    const nextMonthBtn = document.getElementById('next-month-btn');

    const currentCalendarDate = new Date();
    currentCalendarDate.setDate(1); // Default to start of month

    async function renderSessions() {
        if (!sessionsGrid || !monthDisplay) return;

        try {
            // we use getSessions from adminApi - note backend must allow GET /api/sessions without auth!
            // Wait, is GET /api/sessions protected? Let's check server.ts.
            const sessions = await apiFetch('/api/sessions');

            const sessionTypes = await apiFetch('/api/session-types');
            const availableSessionTypes = sessionTypes.map((type: { label: string }) => type.label);

            // Render read-only calendar (empty bookings array, isAdmin=false, no click handler)
            renderCalendarEvents(
                sessionsGrid,
                monthDisplay,
                currentCalendarDate,
                sessions,
                [],
                false,
                async (session) => {
                    openSessionModal({
                        session,
                        isBooked: false,
                        user: null
                    });
                },
                calendarLegend,
                availableSessionTypes
            );
        } catch (error) {
            console.error('Error loading sessions:', error);
            sessionsGrid.innerHTML = `
                <div class="col-span-full py-12 text-center text-slate-500">
                    <p>Unable to load calendar at this time.</p>
                </div>
            `;
        }
    }

    if (prevMonthBtn)
        prevMonthBtn.addEventListener('click', async () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
            await renderSessions();
        });

    if (nextMonthBtn)
        nextMonthBtn.addEventListener('click', async () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
            await renderSessions();
        });

    // Initial render
    await renderSessions();

    // Responsive listener
    window.addEventListener('resize', () => {
        renderSessions();
    });
}

// Call init when script loads (similar to main.ts)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initJoinApp);
} else {
    initJoinApp();
}
