import type { MembershipType } from '../../auth';
import { escapeHTML } from '../../utils';

function toMembershipOptionMarkup(typeId: string, label: string, checked: boolean): string {
    return `
            <label class="flex items-start gap-3 cursor-pointer group">
                <input type="checkbox" name="membershipType" value="${escapeHTML(typeId)}" ${checked ? 'checked' : ''}
                    class="mt-0.5 accent-brand-gold w-4 h-4 shrink-0" />
                <div>
                    <span class="text-white text-xs font-bold">${escapeHTML(label)}</span>
                    <p class="text-slate-500 text-[10px]">Select this membership type for your account</p>
                </div>
            </label>
        `;
}

export async function renderRegistrationMembershipTypes(
    getMembershipTypes: () => Promise<MembershipType[]>
): Promise<string> {
    const optionsContainer = document.getElementById('registration-membership-types');
    if (!optionsContainer) return 'basic';

    try {
        const membershipTypes = await getMembershipTypes();
        if (!membershipTypes.length) {
            optionsContainer.innerHTML = '<p class="text-xs text-red-400">No membership types configured.</p>';
            return 'basic';
        }
        const defaultMembershipType = membershipTypes.some((t) => t.id === 'basic') ? 'basic' : membershipTypes[0].id;
        optionsContainer.innerHTML = membershipTypes
            .map((t) => toMembershipOptionMarkup(t.id, t.label, t.id === defaultMembershipType))
            .join('');
        return defaultMembershipType;
    } catch {
        optionsContainer.innerHTML = [
            toMembershipOptionMarkup('basic', 'Basic Membership', true),
            toMembershipOptionMarkup('bouldering', 'Bouldering Add-on', false),
            toMembershipOptionMarkup('comp_team', 'Competition Team', false)
        ].join('');
        return 'basic';
    }
}
