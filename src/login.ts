import './style.css';
import { adminApi, authState } from './auth';
import { createDomainEmailPopupController } from './lib/auth/domainEmailPopup';
import { renderRegistrationMembershipTypes } from './lib/auth/membershipOptions';
import { ApiError, getErrorMessage } from './lib/api/http';

export async function initLoginApp() {
    // If the user happens to hit this page while already logged in, redirect them
    await authState.init();
    if (authState.user) {
        window.location.href = '/dashboard';
        return;
    }

    const authGate = document.getElementById('auth-gate');

    const loginToggle = document.getElementById('toggle-login');
    const registerToggle = document.getElementById('toggle-register');
    const loginForm = document.getElementById('login-form') as HTMLFormElement;
    const registerForm = document.getElementById('register-form') as HTMLFormElement;
    const verifyPanel = document.getElementById('verify-panel');
    const forgotPanel = document.getElementById('forgot-panel');
    const resetPanel = document.getElementById('reset-panel');
    const toggleHeader = document.querySelector<HTMLElement>('.flex.border-b');

    const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;
    const loginError = document.getElementById('login-error') as HTMLElement;

    const registerBtn = document.getElementById('register-btn') as HTMLButtonElement;
    const registerError = document.getElementById('register-error') as HTMLElement;
    const domainEmailPopup = document.getElementById('domain-email-popup') as HTMLElement | null;
    const domainEmailPopupBackdrop = document.getElementById('domain-email-popup-backdrop');
    const domainEmailPopupTitle = document.getElementById('domain-email-popup-title') as HTMLElement | null;
    const domainEmailPopupClose = document.getElementById('domain-email-popup-close');
    const domainEmailPopupConfirm = document.getElementById('domain-email-popup-confirm') as HTMLButtonElement | null;
    const domainEmailPopupMessage = document.getElementById('domain-email-popup-message') as HTMLElement | null;
    const domainEmailPopupConfirmWrap = document.getElementById(
        'domain-email-popup-confirm-wrap'
    ) as HTMLElement | null;
    const domainEmailPopupConfirmInput = document.getElementById(
        'domain-email-popup-confirm-input'
    ) as HTMLInputElement | null;
    const domainEmailPopupConfirmError = document.getElementById(
        'domain-email-popup-confirm-error'
    ) as HTMLElement | null;

    const verifyBtn = document.getElementById('verify-btn') as HTMLButtonElement;
    const verifyError = document.getElementById('verify-error') as HTMLElement;
    const verifyCodeInput = document.getElementById('verify-code') as HTMLInputElement;
    const resendLink = document.getElementById('resend-link') as HTMLButtonElement;

    const forgotPasswordLink = document.getElementById('forgot-password-link') as HTMLButtonElement;
    const backToLoginFromForgot = document.getElementById('back-to-login-from-forgot') as HTMLButtonElement;
    const forgotBtn = document.getElementById('forgot-btn') as HTMLButtonElement;
    const forgotEmailInput = document.getElementById('forgot-email') as HTMLInputElement;
    const forgotError = document.getElementById('forgot-error') as HTMLElement;
    const forgotSuccess = document.getElementById('forgot-success') as HTMLElement;

    const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;
    const resetPasswordInput = document.getElementById('reset-password') as HTMLInputElement;
    const resetPasswordConfirm = document.getElementById('reset-password-confirm') as HTMLInputElement;
    const resetError = document.getElementById('reset-error') as HTMLElement;
    const resetSuccess = document.getElementById('reset-success') as HTMLElement;

    // In-memory state for active verification
    let pendingUserId: string | null = null;
    let defaultMembershipType = 'basic';
    defaultMembershipType = await renderRegistrationMembershipTypes(() => adminApi.getMembershipTypes());

    // Fade in layout
    setTimeout(() => {
        authGate?.classList.remove('opacity-0', 'translate-y-4');
    }, 100);

    /** Hide all panels */
    function hideAll() {
        loginForm?.classList.add('hidden');
        registerForm?.classList.add('hidden');
        verifyPanel?.classList.add('hidden');
        forgotPanel?.classList.add('hidden');
        resetPanel?.classList.add('hidden');
        if (toggleHeader) toggleHeader.style.opacity = '';
    }

    /** Show the OTP verification panel, hide other panels */
    function showVerifyPanel(userId: string) {
        pendingUserId = userId;
        hideAll();
        verifyPanel?.classList.remove('hidden');
        if (toggleHeader) toggleHeader.style.opacity = '0.35';
        verifyCodeInput?.focus();
    }

    function showForgotPanel() {
        hideAll();
        forgotPanel?.classList.remove('hidden');
        if (toggleHeader) toggleHeader.style.opacity = '0.35';
        forgotEmailInput?.focus();
    }

    function showResetPanel() {
        hideAll();
        resetPanel?.classList.remove('hidden');
        if (toggleHeader) toggleHeader.style.opacity = '0.35';
        resetPasswordInput?.focus();
    }

    const { showDomainEmailPopup, showRegistrationNumberOverridePopup } = createDomainEmailPopupController({
        popup: domainEmailPopup,
        backdrop: domainEmailPopupBackdrop as HTMLElement | null,
        title: domainEmailPopupTitle,
        closeButton: domainEmailPopupClose as HTMLElement | null,
        confirmButton: domainEmailPopupConfirm,
        message: domainEmailPopupMessage,
        confirmWrap: domainEmailPopupConfirmWrap,
        confirmInput: domainEmailPopupConfirmInput,
        confirmError: domainEmailPopupConfirmError
    });

    // Check if page loaded with a reset token in the URL
    const urlParams = new URLSearchParams(window.location.search);
    const resetToken = urlParams.get('reset_token');
    if (resetToken) {
        showResetPanel();
    }

    // Form Toggles
    loginToggle?.addEventListener('click', () => {
        hideAll();
        pendingUserId = null;

        loginToggle.classList.add('text-brand-gold', 'border-brand-gold');
        loginToggle.classList.remove('text-slate-500', 'border-transparent', 'hover:text-white');
        registerToggle?.classList.remove('text-brand-gold', 'border-brand-gold');
        registerToggle?.classList.add('text-slate-500', 'border-transparent', 'hover:text-white');

        loginForm?.classList.remove('hidden');
    });

    registerToggle?.addEventListener('click', () => {
        hideAll();
        pendingUserId = null;

        registerToggle.classList.add('text-brand-gold', 'border-brand-gold');
        registerToggle.classList.remove('text-slate-500', 'border-transparent', 'hover:text-white');
        loginToggle?.classList.remove('text-brand-gold', 'border-brand-gold');
        loginToggle?.classList.add('text-slate-500', 'border-transparent', 'hover:text-white');

        registerForm?.classList.remove('hidden');
    });

    // Forgot Password link
    forgotPasswordLink?.addEventListener('click', () => {
        showForgotPanel();
    });

    backToLoginFromForgot?.addEventListener('click', () => {
        hideAll();
        loginForm?.classList.remove('hidden');
        if (toggleHeader) toggleHeader.style.opacity = '';
    });

    // Login Submission
    loginForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.classList.add('hidden');
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<span>Authenticating...</span>';

        const email = (document.getElementById('login-email') as HTMLInputElement).value;
        const password = (document.getElementById('login-password') as HTMLInputElement).value;

        try {
            await authState.login(email, password);
            window.location.href = '/dashboard';
        } catch (error) {
            if (error instanceof ApiError && error.pendingVerification && error.userId) {
                showVerifyPanel(error.userId);
            } else {
                loginError.textContent = getErrorMessage(error, 'Login failed.');
                loginError.classList.remove('hidden');
            }
            loginBtn.disabled = false;
            loginBtn.innerHTML = `<span>Access Portal</span><svg class="w-5 h-5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"></path></svg>`;
        }
    });

    // Register Submission
    registerForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        registerError.classList.add('hidden');
        registerBtn.disabled = true;
        registerBtn.textContent = 'Creating Account...';

        const firstName = (document.getElementById('reg-fname') as HTMLInputElement).value;
        const lastName = (document.getElementById('reg-sname') as HTMLInputElement).value;
        const email = (document.getElementById('reg-email') as HTMLInputElement).value;
        const registrationNumber = (document.getElementById('reg-regnum') as HTMLInputElement).value.trim();
        const password = (document.getElementById('reg-password') as HTMLInputElement).value;
        const passwordConfirm = (document.getElementById('reg-password-confirm') as HTMLInputElement).value;
        const normalizedEmail = email.trim().toLowerCase();

        // Collect checked membership types
        const membershipTypes: string[] = [];
        document.querySelectorAll<HTMLInputElement>('input[name="membershipType"]:checked').forEach((cb) => {
            membershipTypes.push(cb.value);
        });
        if (membershipTypes.length === 0) membershipTypes.push(defaultMembershipType);

        if (password !== passwordConfirm) {
            registerError.textContent = 'Passwords do not match.';
            registerError.classList.remove('hidden');
            registerBtn.disabled = false;
            registerBtn.textContent = 'Create Account';
            return;
        }

        if (normalizedEmail !== 'committee@sheffieldclimbing.org' && !normalizedEmail.endsWith('@sheffield.ac.uk')) {
            const msg = 'Please register with your @sheffield.ac.uk email address.';
            registerError.textContent = msg;
            registerError.classList.remove('hidden');
            showDomainEmailPopup(msg);
            registerBtn.disabled = false;
            registerBtn.textContent = 'Create Account';
            return;
        }

        if (!/^2\d{8}$/.test(registrationNumber)) {
            registerBtn.disabled = false;
            registerBtn.textContent = 'Create Account';
            const proceed = await showRegistrationNumberOverridePopup(registrationNumber);
            if (!proceed) return;
            registerBtn.disabled = true;
            registerBtn.textContent = 'Creating Account...';
        }

        try {
            const data = await authState.register(
                firstName,
                lastName,
                normalizedEmail,
                password,
                passwordConfirm,
                registrationNumber,
                membershipTypes
            );

            if (data.pendingVerification && data.userId) {
                // Email verification required — show the OTP panel
                showVerifyPanel(data.userId);
                registerBtn.disabled = false;
                registerBtn.textContent = 'Create Account';
                return;
            }

            // No verification needed (test env / root admin) — already logged in
            window.location.href = '/dashboard';
        } catch (error) {
            const msg = getErrorMessage(error, 'Registration failed.');
            registerError.textContent = msg;
            registerError.classList.remove('hidden');
            if (msg.toLowerCase().includes('@sheffield.ac.uk')) {
                showDomainEmailPopup(msg);
            }
            registerBtn.disabled = false;
            registerBtn.textContent = 'Create Account';
        }
    });

    // Verify Button
    verifyBtn?.addEventListener('click', async () => {
        if (!pendingUserId) return;

        const code = verifyCodeInput?.value?.trim() || '';
        if (code.length !== 6) {
            verifyError.textContent = 'Please enter the full 6-digit code.';
            verifyError.classList.remove('hidden');
            return;
        }

        verifyError.classList.add('hidden');
        verifyBtn.disabled = true;
        verifyBtn.innerHTML = '<span>Verifying...</span>';

        try {
            await authState.verifyEmail(pendingUserId, code);
            window.location.href = '/dashboard';
        } catch (error) {
            verifyError.textContent = getErrorMessage(error, 'Verification failed. Please try again.');
            verifyError.classList.remove('hidden');
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = `<span>Verify Email</span><svg class="w-5 h-5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;
        }
    });

    // Auto-submit when 6 digits entered
    verifyCodeInput?.addEventListener('input', () => {
        const val = verifyCodeInput.value.replace(/[^0-9]/g, '');
        verifyCodeInput.value = val;
        if (val.length === 6) verifyBtn?.click();
    });

    // Resend Code
    resendLink?.addEventListener('click', async () => {
        if (!pendingUserId) return;

        resendLink.textContent = 'Sending...';
        resendLink.disabled = true;

        try {
            await authState.requestVerification(pendingUserId);
            resendLink.textContent = 'Sent! Check your inbox.';
            setTimeout(() => {
                resendLink.textContent = 'Resend code';
                resendLink.disabled = false;
            }, 5000);
        } catch {
            resendLink.textContent = 'Failed to resend.';
            resendLink.disabled = false;
        }
    });

    // Forgot Password Submit
    forgotBtn?.addEventListener('click', async () => {
        forgotError.classList.add('hidden');
        forgotSuccess.classList.add('hidden');

        const email = forgotEmailInput.value.trim();
        if (!email) {
            forgotError.textContent = 'Please enter your email address.';
            forgotError.classList.remove('hidden');
            return;
        }

        forgotBtn.disabled = true;
        forgotBtn.innerHTML = '<span>Sending...</span>';

        try {
            await authState.forgotPassword(email);
            forgotSuccess.textContent = 'If that email is registered, a reset link has been sent. Check your inbox.';
            forgotSuccess.classList.remove('hidden');
            forgotEmailInput.value = '';
        } catch (error) {
            forgotError.textContent = getErrorMessage(error, 'Failed to send reset email.');
            forgotError.classList.remove('hidden');
        } finally {
            forgotBtn.disabled = false;
            forgotBtn.innerHTML = '<span>Send Reset Link</span>';
        }
    });

    // Reset Password Submit
    resetBtn?.addEventListener('click', async () => {
        resetError.classList.add('hidden');
        resetSuccess.classList.add('hidden');

        const newPassword = resetPasswordInput.value;
        const confirm = resetPasswordConfirm.value;

        if (!newPassword || newPassword.length < 6) {
            resetError.textContent = 'Password must be at least 6 characters.';
            resetError.classList.remove('hidden');
            return;
        }
        if (newPassword !== confirm) {
            resetError.textContent = 'Passwords do not match.';
            resetError.classList.remove('hidden');
            return;
        }

        if (!resetToken) {
            resetError.textContent = 'Invalid reset link. Please request a new one.';
            resetError.classList.remove('hidden');
            return;
        }

        resetBtn.disabled = true;
        resetBtn.innerHTML = '<span>Updating...</span>';

        try {
            await authState.resetPassword(resetToken, newPassword);
            resetSuccess.textContent = 'Password updated! Redirecting to login...';
            resetSuccess.classList.remove('hidden');
            resetBtn.classList.add('hidden');
            setTimeout(() => {
                window.location.href = '/login';
            }, 2000);
        } catch (error) {
            resetError.textContent = getErrorMessage(error, 'Failed to reset password. The link may have expired.');
            resetError.classList.remove('hidden');
            resetBtn.disabled = false;
            resetBtn.innerHTML = '<span>Update Password</span>';
        }
    });
}

// Call init when script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLoginApp);
} else {
    initLoginApp();
}
