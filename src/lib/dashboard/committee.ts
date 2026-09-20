import { authState, committeeApi, adminApi } from '../../auth';
import { showToast } from '../../utils';

type PhotoCropEditor = {
    open: (file: File, uploadFn: (blob: Blob) => Promise<string>, onSuccess?: (photoPath: string) => void) => void;
};

export function initCommitteeProfileHandlers(photoCropEditor?: PhotoCropEditor | null) {
    const committeeProfileCard = document.getElementById('committee-profile-card');
    const profilePhotoInput = document.getElementById('profile-photo-input') as HTMLInputElement;
    const uploadPhotoBtn = document.getElementById('upload-photo-btn');
    const profilePreview = document.getElementById('profile-preview') as HTMLImageElement;
    const profilePlaceholder = document.getElementById('profile-placeholder');
    const instagramInput = document.getElementById('comm-instagram') as HTMLInputElement;
    const faveCragInput = document.getElementById('comm-fave-crag') as HTMLInputElement;
    const bioInput = document.getElementById('comm-bio') as HTMLTextAreaElement;
    const saveBtn = document.getElementById('save-comm-profile-btn');

    if (!committeeProfileCard) return;
    const committeeProfileCardEl = committeeProfileCard as HTMLElement;

    function isCommitteeUser(user: any) {
        return (
            !!user &&
            (user.role === 'committee' ||
                !!user.committeeRole ||
                (Array.isArray(user.committeeRoles) && user.committeeRoles.length > 0))
        );
    }

    function refreshCardVisibilityAndData() {
        const user = authState.getUser();
        if (isCommitteeUser(user)) {
            committeeProfileCardEl.classList.remove('hidden');
            populateCommitteeFields();
            return;
        }
        committeeProfileCardEl.classList.add('hidden');
    }

    // Initial pass (may run before auth init finishes)
    refreshCardVisibilityAndData();
    // Re-run after dashboard/auth state updates
    window.addEventListener('dashboardUpdate', refreshCardVisibilityAndData);

    async function populateCommitteeFields() {
        const user = authState.getUser();
        if (!user) return;

        // Populate existing values
        if (instagramInput) instagramInput.value = user.instagram || '';
        if (faveCragInput) faveCragInput.value = user.faveCrag || '';
        if (bioInput) bioInput.value = user.bio || '';

        if (user.profilePhoto) {
            if (profilePreview) {
                profilePreview.src = user.profilePhoto;
                profilePreview.classList.remove('hidden');
            }
            if (profilePlaceholder) profilePlaceholder.classList.add('hidden');
        }
    }

    // Photo Upload Handlers
    if (uploadPhotoBtn && profilePhotoInput) {
        uploadPhotoBtn.addEventListener('click', () => profilePhotoInput.click());

        profilePhotoInput.addEventListener('change', () => {
            const file = profilePhotoInput.files?.[0];
            if (!file) return;

            if (photoCropEditor) {
                profilePhotoInput.value = '';
                photoCropEditor.open(
                    file,
                    async (blob) => {
                        const fileFromBlob = new File([blob], 'profile.jpg', { type: blob.type || 'image/jpeg' });
                        const data = await committeeApi.uploadPhoto(fileFromBlob);
                        const user = authState.getUser();
                        if (user) user.profilePhoto = data.photoPath;
                        return data.photoPath;
                    },
                    (photoPath) => {
                        if (profilePreview) {
                            profilePreview.src = photoPath;
                            profilePreview.classList.remove('hidden');
                        }
                        if (profilePlaceholder) profilePlaceholder.classList.add('hidden');
                    }
                );
            } else {
                showToast('Photo crop editor unavailable. Please refresh the page and try again.', 'error');
            }
        });
    }

    // Profile Save Handler
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const profile = {
                instagram: instagramInput.value.trim(),
                faveCrag: faveCragInput.value.trim(),
                bio: bioInput.value.trim()
            };

            try {
                saveBtn.textContent = 'Saving...';
                (saveBtn as HTMLButtonElement).disabled = true;

                await committeeApi.updateMyProfile(profile);
                showToast('Committee profile updated!', 'success');

                // Update local user state
                const user = authState.getUser();
                if (user) {
                    user.instagram = profile.instagram;
                    user.faveCrag = profile.faveCrag;
                    user.bio = profile.bio;
                }
            } catch (err: any) {
                showToast(err.message || 'Failed to update profile', 'error');
            } finally {
                saveBtn.textContent = 'Save Profile';
                (saveBtn as HTMLButtonElement).disabled = false;
            }
        });
    }
}

export async function initCsvExportModal() {
    const modal = document.getElementById('csv-export-modal');
    const backdrop = document.getElementById('csv-export-backdrop');
    const cancelBtn = document.getElementById('csv-export-cancel-btn');
    const confirmBtn = document.getElementById('csv-export-confirm-btn');
    const typeSelect = document.getElementById('csv-export-membership-type') as HTMLSelectElement;
    const exportBtn = document.getElementById('open-csv-export-modal-btn');

    if (!modal || !exportBtn) return;

    // Populate membership types when modal is about to open
    async function populateMembershipTypes() {
        try {
            const membershipTypes = await adminApi.getMembershipTypes();
            if (typeSelect) {
                typeSelect.innerHTML = '<option value="">-- Select a type --</option>';
                membershipTypes.forEach((type) => {
                    const option = document.createElement('option');
                    option.value = type.id;
                    option.textContent = type.label;
                    if (type.deprecated) {
                        option.textContent += ' (Deprecated)';
                    }
                    typeSelect.appendChild(option);
                });
            }
        } catch {
            showToast('Failed to load membership types', 'error');
        }
    }

    function closeModal() {
        if (modal) modal.classList.add('hidden');
    }

    function openModal() {
        if (modal) {
            modal.classList.remove('hidden');
            typeSelect.value = '';
            populateMembershipTypes();
        }
    }

    exportBtn.addEventListener('click', () => {
        openModal();
    });

    if (backdrop) {
        backdrop.addEventListener('click', closeModal);
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeModal);
    }

    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            const selectedType = typeSelect.value;
            if (!selectedType) {
                showToast('Please select a membership type', 'error');
                return;
            }

            try {
                confirmBtn.textContent = 'Exporting...';
                (confirmBtn as HTMLButtonElement).disabled = true;

                await committeeApi.exportMembersCSV(selectedType);
                showToast('CSV export started', 'success');
                closeModal();
            } catch (err: any) {
                showToast(err.message || 'Failed to export CSV', 'error');
            } finally {
                confirmBtn.textContent = 'Export';
                (confirmBtn as HTMLButtonElement).disabled = false;
            }
        });
    }
}
