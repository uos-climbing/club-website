import { adminApi, authState, type Session } from '../../auth';
import { renderCalendarEvents } from '../../calendar';
import { openSessionModal } from '../../components/sessionModal';
import { escapeHTML } from '../../utils';

const currentCalendarDate = new Date();
let activeFilter: string = 'all';

export async function renderSessions(isAdmin: boolean) {
    const calendarGrid = document.getElementById('calendar-grid');
    const calendarLegend = document.getElementById('calendar-legend');
    const calendarMonthDisplay = document.getElementById('calendar-month-display');
    const mobileDisplays = document.querySelectorAll('.calendar-month-mobile-display');
    if (!calendarGrid) return;

    const formattedDate = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(
        currentCalendarDate
    );
    if (calendarMonthDisplay) calendarMonthDisplay.textContent = formattedDate;
    mobileDisplays.forEach((el) => (el.textContent = formattedDate));

    const allSessions = await adminApi.getSessions();
    const sessionTypes = await adminApi.getSessionTypes();
    let myBookings: string[] = [];
    if (authState.getUser()) {
        myBookings = await adminApi.getMyBookings();
    }

    // Update filter buttons if they exist
    const filtersContainer = document.getElementById('calendar-filters-container');
    if (filtersContainer) {
        const filters = [{ id: 'all', label: 'All' }, ...sessionTypes.map((t) => ({ id: t.id, label: t.label }))];
        filtersContainer.innerHTML = filters
            .map(
                (f: any) => `
            <button id="filter-${escapeHTML(f.id)}" data-filter="${escapeHTML(f.id)}"
                class="session-filter-btn whitespace-nowrap px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all duration-150 ${f.id === activeFilter ? 'border-brand-gold bg-brand-gold/20 text-brand-gold' : 'border-slate-700 text-slate-400'}">
                ${escapeHTML(f.label)}
            </button>
        `
            )
            .join('');

        // Re-attach filter listeners since we just replaced the HTML
        filtersContainer.querySelectorAll('.session-filter-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                activeFilter = (btn as HTMLElement).dataset.filter!;
                await renderSessions(isAdmin);
            });
        });
    }

    // Apply membership type filter (note: session.type is what we filter on)
    const sessions = activeFilter === 'all' ? allSessions : allSessions.filter((s: Session) => s.type === activeFilter);

    renderCalendarEvents(
        calendarGrid,
        calendarMonthDisplay,
        currentCalendarDate,
        sessions,
        myBookings,
        isAdmin,
        async (session: Session, isBooked: boolean) => {
            openSessionModal({
                session,
                isBooked,
                user: authState.user,
                onBook: async (id) => {
                    await adminApi.bookSession(id);
                    await renderSessions(isAdmin);
                },
                onCancel: async (id) => {
                    await adminApi.cancelSession(id);
                    await renderSessions(isAdmin);
                },
                onEditSuccess: async () => {
                    await renderSessions(isAdmin);
                },
                onDeleteSuccess: async () => {
                    await renderSessions(isAdmin);
                }
            });
        },
        calendarLegend,
        sessionTypes.map((type) => type.label)
    );
}

export function initSessionHandlers() {
    window.addEventListener('resize', () => {
        const isAdmin = !!document.getElementById('committee-tabs');
        renderSessions(isAdmin);
    });

    const sessionTypeSelect = document.getElementById('session-type');
    if (sessionTypeSelect) {
        adminApi.getSessionTypes().then((types) => {
            sessionTypeSelect.innerHTML = types
                .map((t: any) => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.label)}</option>`)
                .join('');
        });
    }

    const sessionRegistrationRuleSelect = document.getElementById(
        'session-registration-rule'
    ) as HTMLSelectElement | null;
    if (sessionRegistrationRuleSelect) {
        adminApi
            .getMembershipTypes()
            .then((types) => {
                const activeTypes = types.filter((t) => !t.deprecated || t.id === 'basic');
                const membershipOptions = activeTypes.length
                    ? activeTypes
                          .map(
                              (m: any) => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.label)} Members</option>`
                          )
                          .join('')
                    : '<option value="basic">Basic Members</option>';
                sessionRegistrationRuleSelect.innerHTML = `
                ${membershipOptions}
                <option value="committee_only">Committee Only</option>
            `;
            })
            .catch(() => {
                sessionRegistrationRuleSelect.innerHTML = `
                <option value="basic">Basic Members</option>
                <option value="committee_only">Committee Only</option>
            `;
            });
    }

    const sessionVisibilitySelect = document.getElementById('session-visibility') as HTMLSelectElement | null;
    if (sessionVisibilitySelect) {
        sessionVisibilitySelect.value = 'all';
    }
    if (sessionRegistrationRuleSelect) {
        sessionRegistrationRuleSelect.value = 'basic';
    }

    const filtersContainer = document.getElementById('calendar-filters-container');
    if (filtersContainer) {
        filtersContainer.innerHTML = `
            <button id="filter-all" data-filter="all"
                class="session-filter-btn whitespace-nowrap px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all duration-150 border-brand-gold bg-brand-gold/20 text-brand-gold">
                All
            </button>
        `;
    }

    const prevMonthBtn = document.getElementById('prev-month-btn');
    const nextMonthBtn = document.getElementById('next-month-btn');
    const addSessionToggleBtn = document.getElementById('add-session-toggle-btn');
    const addSessionFormContainer = document.getElementById('add-session-form-container');
    const addSessionForm = document.getElementById('add-session-form');
    const cancelSessionBtn = document.getElementById('cancel-session-btn');

    const getIsCommittee = () => {
        const u = authState.getUser();
        if (!u) return false;
        return (
            u.role === 'committee' ||
            !!u.committeeRole ||
            (Array.isArray(u.committeeRoles) && u.committeeRoles.length > 0)
        );
    };

    const nextMonthBtnMobile = document.getElementById('next-month-btn-mobile');
    const updateBothMonths = async () => {
        await renderSessions(getIsCommittee());
    };

    if (prevMonthBtn)
        prevMonthBtn.addEventListener('click', async () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
            await updateBothMonths();
        });
    if (nextMonthBtn)
        nextMonthBtn.addEventListener('click', async () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
            await updateBothMonths();
        });
    if (nextMonthBtnMobile)
        nextMonthBtnMobile.addEventListener('click', async () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
            await updateBothMonths();
        });

    if (addSessionToggleBtn && addSessionFormContainer) {
        addSessionToggleBtn.addEventListener('click', () => {
            addSessionFormContainer.classList.toggle('hidden');
        });
    }

    if (cancelSessionBtn && addSessionFormContainer) {
        cancelSessionBtn.addEventListener('click', () => {
            addSessionFormContainer.classList.add('hidden');
        });
    }

    if (addSessionForm) {
        addSessionForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = (document.getElementById('session-title') as HTMLInputElement).value;
            const type = (document.getElementById('session-type') as HTMLSelectElement).value as any;
            const location = (document.getElementById('session-location') as HTMLInputElement).value;
            const dateStr = (document.getElementById('session-date') as HTMLInputElement).value;
            const capacity = parseInt((document.getElementById('session-capacity') as HTMLInputElement).value, 10);
            const registrationRule =
                (document.getElementById('session-registration-rule') as HTMLSelectElement)?.value || 'basic';
            const visibility = ((document.getElementById('session-visibility') as HTMLSelectElement)?.value ||
                'all') as 'all' | 'committee_only';
            const registrationVisibility = registrationRule === 'committee_only' ? 'committee_only' : 'all';
            const requiredMembership = registrationRule === 'committee_only' ? undefined : registrationRule;

            if (title && type && dateStr && !isNaN(capacity)) {
                await adminApi.addSession({
                    title,
                    type,
                    date: dateStr,
                    location,
                    capacity,
                    requiredMembership,
                    visibility,
                    registrationVisibility
                });
                (addSessionForm as HTMLFormElement).reset();
                addSessionFormContainer?.classList.add('hidden');
                await renderSessions(getIsCommittee());
            }
        });
    }

    // Membership filter buttons
    document.querySelectorAll<HTMLButtonElement>('.session-filter-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const filter = btn.dataset.filter!;
            activeFilter = filter;

            // Update active state styling
            document.querySelectorAll<HTMLButtonElement>('.session-filter-btn').forEach((b) => {
                b.classList.remove('bg-brand-gold/20', 'text-brand-gold', 'border-brand-gold');
                b.classList.add('border-slate-700', 'text-slate-400');
            });

            btn.classList.add('bg-brand-gold/20', 'text-brand-gold', 'border-brand-gold');
            btn.classList.remove('border-slate-700', 'text-slate-400');

            await renderSessions(getIsCommittee());
        });
    });
}
