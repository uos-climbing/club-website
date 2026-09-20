import { adminApi } from '../../auth';
import { escapeHTML, showConfirmModal, showPromptModal, showToast } from '../../utils';

export async function renderMembershipTypes() {
    const listContainer = document.getElementById('membership-types-list');
    if (!listContainer) return;

    try {
        const types = await adminApi.getMembershipTypes();

        if (types.length === 0) {
            listContainer.innerHTML =
                '<div class="p-8 text-center text-slate-500 text-sm italic">No membership types configured.</div>';
            return;
        }

        listContainer.innerHTML = types
            .map(
                (t) => `
            <div class="flex items-center justify-between p-4 bg-slate-800/20 hover:bg-slate-800/40 transition-colors border-b border-white/5 last:border-0 ${t.deprecated ? 'opacity-70' : ''}">
                <div>
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-bold text-white">${escapeHTML(t.label)}</span>
                        ${t.deprecated ? '<span class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[8px] font-black uppercase tracking-tighter">Deprecated</span>' : ''}
                    </div>
                    <p class="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">${escapeHTML(t.id)}</p>
                </div>
                <div class="flex gap-2">
                    <button class="deprecate-membership-type-btn p-2 transition-colors ${t.id === 'basic' ? 'text-slate-700 cursor-not-allowed opacity-50' : 'text-slate-500 hover:text-amber-400'}"
                            data-id="${escapeHTML(t.id)}"
                            data-label="${escapeHTML(t.label)}"
                            data-deprecated="${t.deprecated ? 'true' : 'false'}"
                            title="${t.deprecated ? 'Restore Type' : 'Mark as Deprecated'}"
                            ${t.id === 'basic' ? 'disabled' : ''}>
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path>
                        </svg>
                    </button>
                    <button class="edit-membership-type-btn p-2 text-slate-500 hover:text-cyan-300 transition-colors"
                            data-id="${escapeHTML(t.id)}"
                            data-label="${escapeHTML(t.label)}"
                            title="Rename Type">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.586-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.414-8.586z"></path>
                        </svg>
                    </button>
                    <button class="delete-membership-type-btn p-2 transition-colors ${t.id === 'basic' ? 'text-slate-700 cursor-not-allowed opacity-50' : 'text-slate-500 hover:text-red-400'}"
                            data-id="${escapeHTML(t.id)}"
                            data-label="${escapeHTML(t.label)}"
                            title="${t.id === 'basic' ? 'Basic membership cannot be deleted' : 'Delete Type'}"
                            ${t.id === 'basic' ? 'disabled' : ''}>
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `
            )
            .join('');

        listContainer.querySelectorAll('.deprecate-membership-type-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                const target = e.currentTarget as HTMLElement;
                const id = target.dataset.id!;
                const label = target.dataset.label!;
                const isDeprecated = target.dataset.deprecated === 'true';

                const nextAction = isDeprecated ? 'Restore' : 'Deprecate';
                const confirmed = await showConfirmModal(
                    `${nextAction} the "${label}" membership type? ${isDeprecated ? 'It will be visible again for new sessions.' : 'It will be hidden from new session creation but preserved for existing records.'}`
                );
                if (!confirmed) return;

                try {
                    await adminApi.updateMembershipType(id, label, !isDeprecated);
                    showToast(`Membership type ${isDeprecated ? 'restored' : 'deprecated'}`, 'success');
                    await renderMembershipTypes();
                    window.dispatchEvent(new CustomEvent('dashboardUpdate'));
                } catch (err: any) {
                    showToast(err.message || 'Failed to update membership type', 'error');
                }
            });
        });

        listContainer.querySelectorAll('.edit-membership-type-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                const target = e.currentTarget as HTMLElement;
                const id = target.dataset.id!;
                const existingLabel = target.dataset.label!;
                const nextLabel = await showPromptModal('Enter the updated membership label:', existingLabel);
                if (!nextLabel || !nextLabel.trim() || nextLabel.trim() === existingLabel) return;

                try {
                    await adminApi.updateMembershipType(id, nextLabel.trim());
                    showToast('Membership type updated', 'success');
                    await renderMembershipTypes();
                    window.dispatchEvent(new CustomEvent('dashboardUpdate'));
                } catch (err: any) {
                    showToast(err.message || 'Failed to update membership type', 'error');
                }
            });
        });

        listContainer.querySelectorAll('.delete-membership-type-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                const target = e.currentTarget as HTMLElement;
                const id = target.dataset.id!;
                const label = target.dataset.label!;
                if (id === 'basic') {
                    showToast('Basic membership cannot be deleted', 'error');
                    return;
                }
                const confirmed = await showConfirmModal(
                    `Delete the "${label}" membership type? Existing records keep their stored type id.`
                );
                if (!confirmed) return;
                try {
                    await adminApi.deleteMembershipType(id);
                    showToast('Membership type removed', 'success');
                    await renderMembershipTypes();
                    window.dispatchEvent(new CustomEvent('dashboardUpdate'));
                } catch (err: any) {
                    showToast(err.message || 'Failed to delete membership type', 'error');
                }
            });
        });
    } catch (err: any) {
        listContainer.innerHTML = `<div class="p-8 text-center text-red-400 text-sm">Failed to load membership types: ${err.message}</div>`;
    }
}

export function initMembershipTypeHandlers() {
    const addBtn = document.getElementById('add-membership-type-btn');
    if (!addBtn) return;

    addBtn.addEventListener('click', async () => {
        const label = await showPromptModal('Enter a label for the new membership type:', 'e.g. Outdoor Trip Pass');
        if (!label || !label.trim()) return;

        try {
            await adminApi.addMembershipType(label.trim());
            showToast('Membership type added', 'success');
            await renderMembershipTypes();
            window.dispatchEvent(new CustomEvent('dashboardUpdate'));
        } catch (err: any) {
            showToast(err.message || 'Failed to add membership type', 'error');
        }
    });
}
