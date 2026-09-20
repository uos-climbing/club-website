import { adminApi, authState } from '../../auth';
import { escapeHTML, showToast } from '../../utils';
import { createMemberRow, createPendingMembershipRow } from './admin.renderers';

let confirmActionCallback: (() => Promise<void>) | null = null;
let activeRosterPage = 1;
const ITEMS_PER_PAGE = 10;
let currentSearchQuery = '';
let membershipTypeLabelMap: Record<string, string> = {};

function membershipTypeLabel(typeId: string): string {
    return membershipTypeLabelMap[typeId] || typeId;
}

export function initAdminConfirm() {
    const adminConfirmModal = document.getElementById('admin-confirm-modal');
    const adminConfirmBackdrop = document.getElementById('admin-confirm-backdrop');
    const adminConfirmCancelBtn = document.getElementById('admin-confirm-cancel-btn');
    const adminConfirmProceedBtn = document.getElementById('admin-confirm-proceed-btn');

    function closeAdminConfirm() {
        if (adminConfirmModal) adminConfirmModal.classList.add('hidden');
        confirmActionCallback = null;
    }

    [adminConfirmCancelBtn, adminConfirmBackdrop].forEach((el) => {
        if (el) el.addEventListener('click', closeAdminConfirm);
    });

    if (adminConfirmProceedBtn) {
        adminConfirmProceedBtn.addEventListener('click', async () => {
            if (confirmActionCallback) {
                try {
                    const btn = adminConfirmProceedBtn as HTMLButtonElement;
                    btn.disabled = true;
                    btn.textContent = 'Processing...';
                    await confirmActionCallback();
                } catch (err: any) {
                    showToast(err.message || 'Action failed', 'error');
                } finally {
                    const btn = adminConfirmProceedBtn as HTMLButtonElement;
                    btn.disabled = false;
                    btn.textContent = 'Proceed';
                    closeAdminConfirm();
                    // We need a way to trigger UI update.
                    // Maybe pass a callback or dispatch an event.
                    window.dispatchEvent(new CustomEvent('dashboardUpdate'));
                }
            }
        });
    }
}

export function requestAdminConfirmation(title: string, message: string, callback: () => Promise<void>) {
    const titleEl = document.getElementById('admin-confirm-title');
    const msgEl = document.getElementById('admin-confirm-message');
    const adminConfirmModal = document.getElementById('admin-confirm-modal');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    confirmActionCallback = callback;
    if (adminConfirmModal) adminConfirmModal.classList.remove('hidden');
}

export function initSuRosterImport() {
    const input = document.getElementById('su-roster-input') as HTMLTextAreaElement | null;
    const importBtn = document.getElementById('import-su-roster-btn') as HTMLButtonElement | null;
    const resultEl = document.getElementById('su-roster-result');

    if (!input || !importBtn || importBtn.dataset.bound === '1') return;
    importBtn.dataset.bound = '1';

    importBtn.addEventListener('click', async () => {
        const raw = input.value.trim();
        if (!raw) {
            showToast('Paste at least one SU roster row first.', 'error');
            return;
        }

        importBtn.disabled = true;
        const prevText = importBtn.textContent || 'Approve / Pre-Approve';
        importBtn.textContent = 'Importing...';
        if (resultEl) resultEl.textContent = '';

        try {
            const result: any = await adminApi.importSuRoster(raw);
            const summary = `${result.approvedExisting} approved, ${result.preapprovedOnly} pre-approved`;
            const yearSummary = `years: ${result.yearParsedFromSubscription || 0} parsed, ${result.yearFallbackUsed || 0} fallback`;
            if (resultEl) resultEl.textContent = summary;
            showToast(`SU roster imported: ${summary} (${yearSummary})`, 'success');
            window.dispatchEvent(new CustomEvent('dashboardUpdate'));
        } catch (err: any) {
            if (resultEl) resultEl.textContent = '';
            showToast(err.message || 'Failed to import SU roster', 'error');
        } finally {
            importBtn.disabled = false;
            importBtn.textContent = prevText;
        }
    });
}

export async function renderAdminLists() {
    const pendingList = document.getElementById('pending-list');
    const activeList = document.getElementById('active-list');

    // Save open dropdown states before re-rendering so we don't annoy the user
    // when they check a box and the list re-renders
    const openRoleDropdowns = new Set(
        Array.from(document.querySelectorAll('details.admin-role-details[open]')).map((d: any) => d.dataset.id)
    );

    if (!pendingList || !activeList) return;

    try {
        const [membershipTypes, allUsersRaw] = await Promise.all([
            adminApi.getMembershipTypes().catch((e) => {
                console.error('Failed to fetch membership types', e);
                return [];
            }),
            adminApi.getAllUsersRaw()
        ]);

        membershipTypeLabelMap = Object.fromEntries(
            (Array.isArray(membershipTypes) ? membershipTypes : []).map((t: any) => [t.id, t.label])
        );

        if (!Array.isArray(allUsersRaw)) {
            console.error('allUsersRaw is not an array', allUsersRaw);
            pendingList.innerHTML = '<p class="p-5 text-sm text-red-400 text-center">Failed to load member data.</p>';
            activeList.innerHTML = '<p class="p-5 text-sm text-red-400 text-center">Failed to load member data.</p>';
            return;
        }

        // Flatten ALL pending membership rows (across all users)
        const pendingMemberships: any[] = [];
        allUsersRaw.forEach((u) => {
            if (u.memberships && Array.isArray(u.memberships)) {
                (u.memberships as any[]).forEach((m) => {
                    if (m.status === 'pending') {
                        pendingMemberships.push({ user: u, membership: m });
                    }
                });
            }
        });

        pendingList.innerHTML = pendingMemberships.length
            ? pendingMemberships
                  .map((pm) => createPendingMembershipRow(pm.user, pm.membership, membershipTypeLabel))
                  .join('')
            : '<p class="p-5 text-sm text-slate-500 text-center">No pending registrations.</p>';

        // Render Active — committee members/role-holders + anyone with active membership data.
        const allActive = allUsersRaw.filter((u: any) => {
            const isCommittee =
                u.role === 'committee' ||
                !!u.committeeRole ||
                (Array.isArray(u.committeeRoles) && u.committeeRoles.length > 0);
            if (isCommittee) return true;
            const hasActiveMembershipRow = ((u.memberships as any[]) || []).some((m: any) => m.status === 'active');
            return hasActiveMembershipRow || u.membershipStatus === 'active';
        });

        // Apply search filter if query exists
        const filteredActive = allActive.filter((u) => {
            if (!currentSearchQuery) return true;
            const q = currentSearchQuery.toLowerCase();
            const displayName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.name || '';
            const nameMatch = displayName.toLowerCase().includes(q);
            const emailMatch = (u.email || '').toLowerCase().includes(q);
            const regMatch = (u.registrationNumber || '').toLowerCase().includes(q);
            return nameMatch || emailMatch || regMatch;
        });

        const totalActive = filteredActive.length;

        // Optional: Render search input
        const searchHtml = `
            <div class="px-5 py-3 border-b border-white/10 bg-slate-900/30">
                <input type="text" id="roster-search-input" value="${escapeHTML(currentSearchQuery)}" placeholder="Search members by name, email, or reg no..." class="w-full bg-slate-800 text-sm text-white border border-slate-700 rounded-lg px-3 py-2 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none">
            </div>
        `;

        // Pagination logic
        const totalPages = Math.ceil(totalActive / ITEMS_PER_PAGE) || 1;
        if (activeRosterPage > totalPages) activeRosterPage = totalPages;

        const startIdx = (activeRosterPage - 1) * ITEMS_PER_PAGE;
        const endIdx = startIdx + ITEMS_PER_PAGE;
        const pagedActive = filteredActive.slice(startIdx, endIdx);

        let activeHtml = searchHtml;
        activeHtml += pagedActive.length
            ? pagedActive
                  .map((u) =>
                      createMemberRow(u, false, {
                          membershipTypeLabel,
                          currentUserId: authState.user?.id,
                          currentUserEmail: authState.user?.email
                      })
                  )
                  .join('')
            : '<p class="p-5 text-sm text-slate-500 text-center">No active members found.</p>';

        if (totalActive > ITEMS_PER_PAGE) {
            activeHtml += `
                <div class="px-5 py-3 border-t border-slate-700 flex justify-between items-center text-xs text-slate-400">
                    <div>Showing ${startIdx + 1}-${Math.min(endIdx, totalActive)} of ${totalActive} Members</div>
                    <div class="flex gap-2">
                        <button class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50" ${activeRosterPage === 1 ? 'disabled' : ''} id="prev-member-page-btn">Prev</button>
                        <button class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50" ${activeRosterPage >= totalPages ? 'disabled' : ''} id="next-member-page-btn">Next</button>
                    </div>
                </div>
            `;
        }

        activeList.innerHTML = activeHtml;
    } catch (err: any) {
        console.error('Failed to render admin lists:', err);
        pendingList.innerHTML = '<p class="p-5 text-sm text-red-400 text-center">Failed to load member data.</p>';
        activeList.innerHTML = '<p class="p-5 text-sm text-red-400 text-center">Failed to load member data.</p>';
    }

    // Restore open state
    openRoleDropdowns.forEach((id) => {
        const details = document.querySelector(
            `details.admin-role-details[data-id="${id}"]`
        ) as HTMLDetailsElement | null;
        if (details) details.open = true;
    });

    // Attach search listener
    const searchInput = document.getElementById('roster-search-input') as HTMLInputElement | null;
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentSearchQuery = (e.target as HTMLInputElement).value;
            activeRosterPage = 1; // reset to first page on search
            renderAdminLists();
        });
        // Refocus to keep typing seamless
        if (currentSearchQuery) {
            searchInput.focus();
            const len = searchInput.value.length;
            searchInput.setSelectionRange(len, len);
        }
    }

    // Attach pagination listeners
    const prevPageBtn = document.getElementById('prev-member-page-btn');
    const nextPageBtn = document.getElementById('next-member-page-btn');
    if (prevPageBtn)
        prevPageBtn.addEventListener('click', async () => {
            activeRosterPage--;
            await renderAdminLists();
        });
    if (nextPageBtn)
        nextPageBtn.addEventListener('click', async () => {
            activeRosterPage++;
            await renderAdminLists();
        });

    // Attach Event Listeners to generated action buttons
    document.querySelectorAll('.admin-action-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            const button = target.closest('.admin-action-btn') as HTMLElement;
            const action = button.dataset.action;
            const id = button.dataset.id;
            const name = button.dataset.name;

            if (id && action) {
                let title = 'Confirm Action';
                let message = `Are you sure you want to perform this action?`;
                let actionCallback: () => Promise<any> = async () => {};

                if (action === 'approve') {
                    title = 'Approve Member';
                    message = `Are you sure you want to approve ${name} for active membership?`;
                    actionCallback = async () => adminApi.approveMember(id);
                }
                if (action === 'reject') {
                    title = 'Reject Member';
                    message = `Are you sure you want to reject ${name}'s membership registration?`;
                    actionCallback = async () => adminApi.rejectMember(id);
                }
                if (action === 'approve-membership') {
                    title = 'Approve Membership Type';
                    message = `Approve this specific membership type for ${name}?`;
                    actionCallback = async () => adminApi.approveMembershipRow(id);
                }
                if (action === 'reject-membership') {
                    title = 'Reject Membership Type';
                    message = `Reject this specific membership type for ${name}?`;
                    actionCallback = async () => adminApi.rejectMembershipRow(id);
                }
                if (action === 'promote') {
                    title = 'Promote to Admin';
                    message = `Are you sure you want to promote ${name} to committee admin? They will have full access.`;
                    actionCallback = async () => adminApi.promoteToCommittee(id);
                }
                if (action === 'demote') {
                    title = 'Remove Admin';
                    message = `Are you sure you want to remove admin privileges for ${name}?`;
                    actionCallback = async () => adminApi.demoteToMember(id);
                }
                if (action === 'delete') {
                    if (id === authState.user?.id) {
                        showToast('You cannot delete your own account from the admin roster.', 'error');
                        return;
                    }
                    title = 'Delete Member';
                    message = `Are you absolutely sure you want to permanently delete ${escapeHTML(name)}'s account? This action cannot be undone.`;
                    actionCallback = async () => adminApi.deleteUser(id);
                }
                if (action === 'delete-membership') {
                    title = 'Remove Membership';
                    message = `Remove this membership from ${name}? This cannot be undone.`;
                    actionCallback = async () => adminApi.deleteMembershipRow(id);
                }

                requestAdminConfirmation(title, message, actionCallback);
            }
        });
    });

    // Attach Event Listeners to committee role checkboxes
    document.querySelectorAll('.admin-role-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', async (e) => {
            const target = e.target as HTMLInputElement;
            const id = target.dataset.id;
            if (!id) return;

            // Collect all checked roles for this user
            const allChecked = Array.from(
                document.querySelectorAll<HTMLInputElement>(`.admin-role-checkbox[data-id="${id}"]:checked`)
            ).map((cb) => cb.value);

            // Disable all checkboxes for this user while saving
            document
                .querySelectorAll<HTMLInputElement>(`.admin-role-checkbox[data-id="${id}"]`)
                .forEach((cb) => (cb.disabled = true));

            try {
                await adminApi.setCommitteeRole(id, allChecked);
                // Brief visual confirmation
                setTimeout(async () => {
                    await renderAdminLists();
                }, 400);
            } catch (err: any) {
                showToast(err.message || 'Failed to update role', 'error');
                // Revert this checkbox
                target.checked = !target.checked;
                document
                    .querySelectorAll<HTMLInputElement>(`.admin-role-checkbox[data-id="${id}"]`)
                    .forEach((cb) => (cb.disabled = false));
            }
        });
    });
}
