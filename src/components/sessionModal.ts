import { adminApi, type Session, type User } from '../auth';
import { escapeHTML, showConfirmModal } from '../utils';

export interface SessionModalOptions {
    session: Session;
    isBooked: boolean;
    user: User | null;
    onBook?: (sessionId: string) => Promise<void>;
    onCancel?: (sessionId: string) => Promise<void>;
    onEditSuccess?: () => void;
    onDeleteSuccess?: () => void;
}

export function openSessionModal(options: SessionModalOptions) {
    const { session, isBooked, user, onBook, onCancel, onEditSuccess, onDeleteSuccess } = options;

    let modal = document.getElementById('unified-session-modal');
    if (!modal) {
        document.body.insertAdjacentHTML(
            'beforeend',
            `
            <div id="unified-session-modal" class="fixed inset-0 z-[100] hidden flex items-center justify-center p-4">
                <div id="unified-session-backdrop" class="absolute inset-0 bg-black/60 backdrop-blur-sm cursor-pointer transition-opacity"></div>
                <div class="relative w-full max-w-md bg-brand-dark border border-white/10 rounded-2xl shadow-2xl p-6 transform transition-all flex flex-col max-h-[90vh] overflow-y-auto">
                    
                    <button id="usm-close-btn" class="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>

                    <div class="text-center mb-6">
                        <span id="usm-icon" class="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3">
                        </span>
                        <h3 id="usm-title" class="text-2xl font-black text-white uppercase tracking-widest break-words leading-tight"></h3>
                        <p id="usm-type" class="text-xs font-bold mt-2 text-slate-400 uppercase tracking-widest"></p>
                    </div>

                    <div class="space-y-4 text-sm text-slate-300 mb-6 bg-slate-800/50 p-4 rounded-xl border border-white/5">
                        <div class="flex justify-between items-center pb-3 border-b border-white/10">
                            <span class="text-slate-500 font-bold uppercase tracking-wider text-xs">Date & Time</span>
                            <span id="usm-datetime" class="font-bold text-white text-right"></span>
                        </div>
                        <div class="flex justify-between items-center pt-1">
                            <span class="text-slate-500 font-bold uppercase tracking-wider text-xs">Availability</span>
                            <span id="usm-capacity" class="font-mono text-white bg-slate-900 px-2 py-1 rounded inline-block"></span>
                        </div>
                        <div id="usm-location-row" class="hidden flex justify-between items-center pt-1">
                            <span class="text-slate-500 font-bold uppercase tracking-wider text-xs">Location</span>
                            <span id="usm-location" class="font-mono text-white text-right"></span>
                        </div>
                        <div id="usm-visibility-row" class="hidden flex justify-between items-center pt-1">
                            <span class="text-slate-500 font-bold uppercase tracking-wider text-xs">Visibility</span>
                            <span id="usm-visibility" class="font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-1 rounded inline-block text-[11px] uppercase tracking-wider">Committee Only</span>
                        </div>
                        <div id="usm-registration-visibility-row" class="hidden flex justify-between items-center pt-1">
                            <span class="text-slate-500 font-bold uppercase tracking-wider text-xs">Registration</span>
                            <span id="usm-registration-visibility" class="font-mono text-cyan-300 bg-cyan-500/10 border border-cyan-500/30 px-2 py-1 rounded inline-block text-[11px] uppercase tracking-wider">Committee Only</span>
                        </div>
                    </div>
                    
                    <p id="usm-error" class="hidden text-red-400 text-xs mb-4 p-3 bg-red-400/10 rounded border border-red-400/20 text-center font-bold"></p>
                    
                    <div id="usm-actions" class="flex flex-col gap-3"></div>

                    <!-- Committee Attendee List -->
                    <div id="usm-attendee-pane" class="hidden mt-6 pt-6 border-t border-white/10">
                        <h4 class="text-sm font-bold text-cyan-400 uppercase flex items-center gap-2 mb-4 tracking-wider">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
                            Attendees (<span id="usm-attendee-count">0</span>)
                        </h4>
                        <div id="usm-attendee-list" class="space-y-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                            <div class="text-center py-4 text-slate-500 text-xs italic">Loading attendees...</div>
                        </div>
                    </div>

                    <!-- Committee Edit Pane -->
                    <div id="usm-edit-pane" class="hidden mt-6 pt-6 border-t border-white/10">
                        <h4 class="text-sm font-bold text-amber-500 uppercase flex items-center gap-2 mb-4 tracking-wider">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                            Committee Override
                        </h4>
                        <form id="usm-edit-form" class="space-y-3">
                            <input type="hidden" id="usm-edit-id">
                            <div class="space-y-1 text-left">
                                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Title</label>
                                <input type="text" id="usm-edit-title" required class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 block">
                            </div>
                            <div class="space-y-1 text-left">
                                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Location</label>
                                <input type="text" id="usm-edit-location" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 block" placeholder="e.g. Main Wall, Roof Cave">
                            </div>
                            <div class="grid grid-cols-2 gap-3 text-left">
                                <div class="space-y-1">
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Date & Time</label>
                                    <input type="datetime-local" id="usm-edit-date" required class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-[11px] focus:outline-none focus:border-amber-500 block">
                                </div>
                                <div class="space-y-1 text-left">
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Type</label>
                                    <select id="usm-edit-type" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-[11px] focus:outline-none focus:border-amber-500 block">
                                    </select>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-3 pb-3 text-left">
                                <div class="space-y-1">
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Capacity</label>
                                    <input type="number" id="usm-edit-capacity" required min="1" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 block">
                                </div>
                                <div class="space-y-1 text-left">
                                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Booked Slots</label>
                                    <input type="number" id="usm-edit-booked" min="0" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500 block">
                                </div>
                            </div>
                            <div class="space-y-1 text-left mt-2">
                                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Visibility</label>
                                <select id="usm-edit-visibility" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-[11px] focus:outline-none focus:border-amber-500 block">
                                    <option value="all">Everyone</option>
                                    <option value="committee_only">Committee Only</option>
                                </select>
                            </div>
                            <div class="space-y-1 text-left mt-2">
                                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">Who Can Register</label>
                                <select id="usm-edit-registration-rule" class="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-white text-[11px] focus:outline-none focus:border-amber-500 block">
                                    <option value="committee_only">Committee Only</option>
                                </select>
                            </div>
                            <div class="flex flex-col gap-2 mt-4 pt-4 border-t border-slate-800">
                                <button type="submit" class="btn-primary w-full !px-4 !py-3 !text-xs uppercase tracking-wider !bg-amber-500 hover:!bg-amber-400 !text-brand-darker !shadow-amber-500/20">Save Adjustments</button>
                                <button type="button" id="usm-delete-btn" class="w-full text-[10px] font-bold px-2 py-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded uppercase tracking-wider transition-colors hidden text-center">Delete Event</button>
                            </div>
                        </form>
                    </div>

                </div>
            </div>
        `
        );
        modal = document.getElementById('unified-session-modal');

        document.getElementById('unified-session-backdrop')?.addEventListener('click', close);
        document.getElementById('usm-close-btn')?.addEventListener('click', close);

        // Let's hook up the edit form submit
        document.getElementById('usm-edit-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = (document.getElementById('usm-edit-id') as HTMLInputElement).value;
            const title = (document.getElementById('usm-edit-title') as HTMLInputElement).value;
            const date = (document.getElementById('usm-edit-date') as HTMLInputElement).value;
            const location = (document.getElementById('usm-edit-location') as HTMLInputElement).value;
            const type = (document.getElementById('usm-edit-type') as HTMLSelectElement).value as any;
            const capacity = parseInt((document.getElementById('usm-edit-capacity') as HTMLInputElement).value, 10);
            const bookedSlots =
                parseInt((document.getElementById('usm-edit-booked') as HTMLInputElement).value, 10) || 0;
            const registrationRule = (document.getElementById('usm-edit-registration-rule') as HTMLSelectElement).value;
            const visibility = (document.getElementById('usm-edit-visibility') as HTMLSelectElement).value as
                'all' | 'committee_only';
            const registrationVisibility = registrationRule === 'committee_only' ? 'committee_only' : 'all';
            const requiredMembership = registrationRule === 'committee_only' ? undefined : registrationRule;

            if (id && title && date && type && !isNaN(capacity)) {
                try {
                    const submitBtn = document.querySelector(
                        '#usm-edit-form button[type="submit"]'
                    ) as HTMLButtonElement;
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Saving...';
                    await adminApi.updateSession(id, {
                        title,
                        date,
                        location,
                        type,
                        capacity,
                        bookedSlots,
                        requiredMembership,
                        visibility,
                        registrationVisibility
                    });
                    close();
                    if ((window as any)._usmCurrentOnEditSuccess) (window as any)._usmCurrentOnEditSuccess();
                } catch (err: any) {
                    showError(err.message || 'Failed to edit session');
                } finally {
                    const submitBtn = document.querySelector(
                        '#usm-edit-form button[type="submit"]'
                    ) as HTMLButtonElement;
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Save Adjustments';
                    }
                }
            }
        });

        document.getElementById('usm-delete-btn')?.addEventListener('click', async () => {
            const id = (document.getElementById('usm-edit-id') as HTMLInputElement).value;
            if (id) {
                const confirmed = await showConfirmModal('Are you sure you want to delete this session?');
                if (confirmed) {
                    try {
                        await adminApi.deleteSession(id);
                        close();
                        if ((window as any)._usmCurrentOnDeleteSuccess) (window as any)._usmCurrentOnDeleteSuccess();
                    } catch (err: any) {
                        showError(err.message || 'Failed to delete session');
                    }
                }
            }
        });
    }

    // Attach callbacks globally so the form event listeners can use them
    (window as any)._usmCurrentOnEditSuccess = onEditSuccess;
    (window as any)._usmCurrentOnDeleteSuccess = onDeleteSuccess;

    const titleEl = document.getElementById('usm-title')!;
    const typeEl = document.getElementById('usm-type')!;
    const datetimeEl = document.getElementById('usm-datetime')!;
    const capacityEl = document.getElementById('usm-capacity')!;
    const visibilityRowEl = document.getElementById('usm-visibility-row')!;
    const registrationVisibilityRowEl = document.getElementById('usm-registration-visibility-row')!;
    const iconEl = document.getElementById('usm-icon')!;
    const actionsEl = document.getElementById('usm-actions')!;
    const errorEl = document.getElementById('usm-error')!;
    const editPaneEl = document.getElementById('usm-edit-pane')!;
    const deleteBtnEl = document.getElementById('usm-delete-btn')!;

    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    // Clear old actions
    const attendeePaneEl = document.getElementById('usm-attendee-pane')!;
    const attendeeListEl = document.getElementById('usm-attendee-list')!;
    const attendeeCountEl = document.getElementById('usm-attendee-count')!;

    actionsEl.innerHTML = '';
    editPaneEl.classList.add('hidden');
    attendeePaneEl.classList.add('hidden');
    deleteBtnEl.classList.add('hidden');

    titleEl.textContent = session.title;
    datetimeEl.innerHTML = new Date(session.date).toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });
    capacityEl.textContent = `${session.bookedSlots} / ${session.capacity} Slots`;
    const locationRowEl = document.getElementById('usm-location-row')!;
    const locationEl = document.getElementById('usm-location')!;
    if ((session as any).location) {
        locationRowEl.classList.remove('hidden');
        locationEl.textContent = escapeHTML((session as any).location);
    } else {
        locationRowEl.classList.add('hidden');
    }
    if ((session as any).visibility === 'committee_only') {
        visibilityRowEl.classList.remove('hidden');
    } else {
        visibilityRowEl.classList.add('hidden');
    }
    if ((session as any).registrationVisibility === 'committee_only') {
        registrationVisibilityRowEl.classList.remove('hidden');
    } else {
        registrationVisibilityRowEl.classList.add('hidden');
    }

    // Styling the icon depending on Type
    if (session.type === 'Competition') {
        iconEl.className =
            'inline-flex items-center justify-center w-12 h-12 rounded-full mb-3 bg-red-500/20 text-red-500';
        typeEl.className = 'text-[10px] font-bold text-red-500 uppercase tracking-widest';
        typeEl.textContent = 'COMPETITION';
    } else if (session.type === 'Social') {
        iconEl.className =
            'inline-flex items-center justify-center w-12 h-12 rounded-full mb-3 bg-brand-gold-muted/20 text-brand-gold-muted';
        typeEl.className = 'text-[10px] font-bold text-brand-gold-muted uppercase tracking-widest';
        typeEl.textContent = 'CLUB SOCIAL';
    } else if (session.type === 'Training Session (Bouldering)') {
        iconEl.className =
            'inline-flex items-center justify-center w-12 h-12 rounded-full mb-3 bg-blue-500/20 text-blue-400';
        typeEl.className = 'text-[10px] font-bold text-blue-400 uppercase tracking-widest';
        typeEl.textContent = 'TRAINING (BOULDERING)';
    } else if (session.type === 'Training Session (Roped)') {
        iconEl.className =
            'inline-flex items-center justify-center w-12 h-12 rounded-full mb-3 bg-purple-500/20 text-purple-400';
        typeEl.className = 'text-[10px] font-bold text-purple-400 uppercase tracking-widest';
        typeEl.textContent = 'TRAINING (ROPED)';
    } else if (session.type === 'Meeting') {
        iconEl.className =
            'inline-flex items-center justify-center w-12 h-12 rounded-full mb-3 bg-emerald-500/20 text-emerald-400';
        typeEl.className = 'text-[10px] font-bold text-emerald-400 uppercase tracking-widest';
        typeEl.textContent = 'CLUB MEETING';
    }
    iconEl.innerHTML = `<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>`;

    function showError(msg: string) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
    }

    if (!user) {
        // Not logged in
        const btn = document.createElement('a');
        btn.href = '/login';
        btn.className =
            'w-full px-4 py-3 bg-brand-gold text-brand-darker hover:bg-white rounded-lg transition-colors text-sm font-bold uppercase shadow-lg shadow-brand-gold/20 text-center flex items-center justify-center gap-2 block';
        btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"></path></svg> Sign In to Book`;
        actionsEl.appendChild(btn);
    } else {
        // Logged in
        if (isBooked) {
            const btn = document.createElement('button');
            btn.className =
                'w-full px-4 py-3 bg-red-400 hover:bg-red-500 text-brand-darker rounded-lg transition-colors text-sm font-black uppercase tracking-wider shadow-[0_0_15px_rgba(248,113,113,0.3)] block';
            btn.innerHTML = `<span class="flex items-center justify-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg> Cancel Booking</span>`;
            btn.onclick = async () => {
                if (onCancel) {
                    btn.disabled = true;
                    btn.textContent = 'Canceling...';
                    try {
                        await onCancel(session.id);
                        close();
                    } catch (err: any) {
                        showError(err.message || 'Action failed.');
                        btn.disabled = false;
                        btn.innerHTML = `<span class="flex items-center justify-center gap-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg> Cancel Booking</span>`;
                    }
                }
            };
            actionsEl.appendChild(btn);
        } else if (session.bookedSlots >= session.capacity) {
            const btn = document.createElement('button');
            btn.className =
                'w-full px-4 py-3 bg-slate-800 text-slate-500 rounded-lg cursor-not-allowed text-sm font-bold uppercase tracking-wider block';
            btn.innerHTML = 'Fully Booked';
            btn.disabled = true;
            actionsEl.appendChild(btn);
        } else {
            const btn = document.createElement('button');
            btn.className =
                'w-full px-4 py-3 bg-brand-gold hover:bg-white text-brand-darker rounded-lg transition-colors text-sm font-black uppercase shadow-[0_0_20px_rgba(253,185,19,0.4)] tracking-wider block';
            btn.textContent = 'Confirm Booking';
            btn.onclick = async () => {
                if (onBook) {
                    btn.disabled = true;
                    btn.textContent = 'Booking...';
                    try {
                        await onBook(session.id);
                        close();
                    } catch (err: any) {
                        showError(err.message || 'Action failed.');
                        btn.disabled = false;
                        btn.textContent = 'Confirm Booking';
                    }
                }
            };
            actionsEl.appendChild(btn);
        }

        // Committee Edit Toggle
        const isCommittee =
            user.role === 'committee' ||
            !!user.committeeRole ||
            (Array.isArray(user.committeeRoles) && user.committeeRoles.length > 0);
        if (isCommittee) {
            const toggleWrapper = document.createElement('div');
            toggleWrapper.className = 'text-center mt-3';

            const toggleBtn = document.createElement('button');
            toggleBtn.className =
                'text-[10px] text-slate-400 hover:text-white underline decoration-dashed underline-offset-4 transition-colors font-bold tracking-wider uppercase inline-block';
            toggleBtn.innerHTML =
                '<span class="flex items-center justify-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg> Expand Admin Options</span>';
            toggleBtn.onclick = () => {
                editPaneEl.classList.toggle('hidden');
                toggleBtn.classList.toggle('text-white');
            };
            toggleWrapper.appendChild(toggleBtn);
            actionsEl.appendChild(toggleWrapper);

            deleteBtnEl.classList.remove('hidden');

            // Populate edit fields
            (document.getElementById('usm-edit-id') as HTMLInputElement).value = session.id;
            (document.getElementById('usm-edit-title') as HTMLInputElement).value = session.title;
            (document.getElementById('usm-edit-date') as HTMLInputElement).value = session.date;
            (document.getElementById('usm-edit-location') as HTMLInputElement).value = (session as any).location || '';

            const typeSelect = document.getElementById('usm-edit-type') as HTMLSelectElement;
            adminApi.getSessionTypes().then((types) => {
                typeSelect.innerHTML = types
                    .map((t) => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.label)}</option>`)
                    .join('');
                typeSelect.value = session.type;
            });

            (document.getElementById('usm-edit-capacity') as HTMLInputElement).value = session.capacity.toString();
            (document.getElementById('usm-edit-booked') as HTMLInputElement).value = session.bookedSlots.toString();
            const registrationRuleSelect = document.getElementById('usm-edit-registration-rule') as HTMLSelectElement;
            adminApi
                .getMembershipTypes()
                .then((types) => {
                    const activeTypes = types.filter((t) => !t.deprecated || t.id === 'basic');
                    const membershipOptions = activeTypes.length
                        ? activeTypes
                              .map((t) => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.label)} Members</option>`)
                              .join('')
                        : '<option value="basic">Basic Members</option>';
                    registrationRuleSelect.innerHTML = `
                    ${membershipOptions}
                    <option value="committee_only">Committee Only</option>
                `;
                    registrationRuleSelect.value =
                        (session as any).registrationVisibility === 'committee_only'
                            ? 'committee_only'
                            : (session as any).requiredMembership ||
                              activeTypes.find((t) => t.id === 'basic')?.id ||
                              activeTypes[0]?.id ||
                              'basic';
                })
                .catch(() => {
                    registrationRuleSelect.innerHTML = `
                    <option value="basic">Basic Members</option>
                    <option value="committee_only">Committee Only</option>
                `;
                    registrationRuleSelect.value =
                        (session as any).registrationVisibility === 'committee_only'
                            ? 'committee_only'
                            : (session as any).requiredMembership || 'basic';
                });
            (document.getElementById('usm-edit-visibility') as HTMLSelectElement).value =
                (session as any).visibility || 'all';

            // Load Attendees
            attendeePaneEl.classList.remove('hidden');
            renderAttendees(session.id, attendeeListEl, attendeeCountEl, onEditSuccess);
        }
    }

    modal!.classList.remove('hidden');
}

async function renderAttendees(sessionId: string, container: HTMLElement, countEl: HTMLElement, onUpdate?: () => void) {
    try {
        const attendees = await adminApi.getSessionAttendees(sessionId);
        countEl.textContent = attendees.length.toString();

        if (attendees.length === 0) {
            container.innerHTML = '<div class="text-center py-4 text-slate-500 text-xs italic">No attendees yet.</div>';
            return;
        }

        container.innerHTML = attendees
            .map(
                (u) => `
            <div class="flex items-center justify-between p-2 rounded bg-white/5 border border-white/5">
                <div class="min-w-0">
                    <p class="text-xs font-bold text-white truncate">${escapeHTML(`${u.firstName || ''} ${u.lastName || ''}`.trim())}</p>
                    <p class="text-[9px] text-slate-500 truncate">${escapeHTML(u.email || '')}</p>
                </div>
                <button class="remove-attendee-btn p-1.5 text-slate-500 hover:text-red-400 transition-colors" data-user-id="${u.id}" title="Remove Attendee">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
        `
            )
            .join('');

        container.querySelectorAll('.remove-attendee-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                const userId = (e.currentTarget as HTMLElement).dataset.userId!;
                const confirmed = await showConfirmModal('Remove this attendee from the session?');
                if (confirmed) {
                    try {
                        await adminApi.removeAttendee(sessionId, userId);
                        renderAttendees(sessionId, container, countEl, onUpdate);
                        if (onUpdate) onUpdate();
                    } catch (err: any) {
                        alert(err.message || 'Failed to remove attendee');
                    }
                }
            });
        });
    } catch (err: any) {
        container.innerHTML = `<div class="text-center py-4 text-red-400 text-xs">Error: ${escapeHTML(err.message || 'Failed to load attendees')}</div>`;
    }
}

function close() {
    document.getElementById('unified-session-modal')?.classList.add('hidden');
}
