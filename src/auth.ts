/**
 * Authentication & Database Module
 * Interfaces with the Express Backend API.
 */

import { adminApi } from './lib/api/admin';
import { committeeApi } from './lib/api/committee';
import { gearApi } from './lib/api/gear';
import { votingApi } from './lib/api/voting';
import { apiFetch } from './lib/api/http';

export interface User {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    name: string;
    password?: string;
    registrationNumber?: string;
    emergencyContactName?: string;
    emergencyContactMobile?: string;
    pronouns?: string;
    dietaryRequirements?: string;
    role: 'member' | 'committee';
    committeeRole?: string | null;
    committeeRoles?: string[];
    membershipStatus: 'active' | 'pending' | 'rejected';
    membershipYear?: string;
    calendarToken?: string;
    instagram?: string;
    faveCrag?: string;
    bio?: string;
    profilePhoto?: string;
    memberships?: MembershipRow[];
}

export interface MembershipRow {
    id: string;
    userId: string;
    membershipType: string;
    status: 'pending' | 'active' | 'rejected';
    membershipYear: string;
}

export interface MembershipType {
    id: string;
    label: string;
    deprecated?: number;
}

export const MEMBERSHIP_TYPE_LABELS: Record<string, string> = {
    basic: 'Basic',
    bouldering: 'Bouldering',
    comp_team: 'Competition Team'
};

export function getCurrentAcademicYear() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed, 0 = Jan, 8 = Sep

    // If before September, academic year started last year
    if (month < 8) {
        return `${year - 1}/${year}`;
    }
    // If September or later, academic year started this year
    return `${year}/${year + 1}`;
}

export interface SessionType {
    id: string;
    label: string;
}

export interface Session {
    id: string;
    type: 'Competition' | 'Social' | 'Training Session (Bouldering)' | 'Training Session (Roped)' | 'Meeting';
    title: string;
    date: string;
    capacity: number;
    bookedSlots: number;
    location?: string;
    requiredMembership?: string;
    visibility?: 'all' | 'committee_only';
    registrationVisibility?: 'all' | 'committee_only';
    seriesId?: string | null;
}

// Current Session State
export const authState = {
    user: null as User | null,

    async init() {
        try {
            const data = await apiFetch('/api/auth/me');
            this.user = data.user;
        } catch (e) {
            this.logout();
        }
    },

    async login(email: string, password?: string) {
        try {
            const data = await apiFetch('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password })
            });
            this.user = data.user;
            return this.user;
        } catch (err: any) {
            if (err.data && err.data.pendingVerification !== undefined) {
                err.pendingVerification = err.data.pendingVerification;
                err.userId = err.data.userId;
            }
            throw err;
        }
    },

    async verifyEmail(userId: string, code: string) {
        const data = await apiFetch('/api/auth/verify-email', {
            method: 'POST',
            body: JSON.stringify({ userId, code })
        });
        this.user = data.user;
        return this.user;
    },

    async requestVerification(userId: string) {
        return apiFetch('/api/auth/request-verification', {
            method: 'POST',
            body: JSON.stringify({ userId })
        });
    },

    async register(
        firstName: string,
        lastName: string,
        email: string,
        passwordHash: string,
        passwordConfirm: string,
        registrationNumber: string,
        membershipTypes: string[]
    ) {
        try {
            const data = await apiFetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    firstName,
                    lastName,
                    email,
                    password: passwordHash,
                    passwordConfirm,
                    registrationNumber,
                    membershipTypes
                })
            });
            this.user = data.user;
            return data;
        } catch (err: any) {
            if (err.data && err.data.pendingVerification !== undefined) {
                err.pendingVerification = err.data.pendingVerification;
                err.userId = err.data.userId;
            }
            throw err;
        }
    },

    async getProfile() {
        return apiFetch('/api/users/me/profile');
    },

    async updateProfile(
        fname: string,
        sname: string,
        emergencyContactName: string,
        emergencyContactMobile: string,
        pronouns: string,
        dietaryRequirements: string
    ) {
        if (!this.user) throw new Error('Not logged in');

        const name = `${fname} ${sname}`.trim();

        await apiFetch(`/api/users/${this.user.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                firstName: fname,
                lastName: sname,
                emergencyContactName,
                emergencyContactMobile,
                pronouns,
                dietaryRequirements
            })
        });

        this.user.firstName = fname;
        this.user.lastName = sname;
        this.user.name = name;
        this.user.emergencyContactName = emergencyContactName;
        this.user.emergencyContactMobile = emergencyContactMobile;
        this.user.pronouns = pronouns;
        this.user.dietaryRequirements = dietaryRequirements;
        return this.user;
    },

    async confirmMembershipRenewal(membershipYear: string, membershipTypes: string[]) {
        if (!this.user) throw new Error('Not logged in');

        const data = await apiFetch('/api/users/me/membership-renewal', {
            method: 'POST',
            body: JSON.stringify({ membershipYear, membershipTypes })
        });

        this.user.membershipYear = data.membershipYear;
        this.user.membershipStatus = data.membershipStatus;
        return this.user;
    },

    async changePassword(currentPassword: string, newPassword: string) {
        if (!this.user) throw new Error('Not logged in');

        return apiFetch('/api/users/me/password', {
            method: 'PUT',
            body: JSON.stringify({ currentPassword, newPassword })
        });
    },

    async forgotPassword(email: string) {
        return apiFetch('/api/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({ email })
        });
    },

    async resetPassword(token: string, newPassword: string) {
        return apiFetch('/api/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({ token, newPassword })
        });
    },

    async getMyMemberships(): Promise<MembershipRow[]> {
        return apiFetch('/api/users/me/memberships');
    },

    async requestMembershipType(membershipType: string, membershipYear?: string) {
        return apiFetch('/api/users/me/memberships', {
            method: 'POST',
            body: JSON.stringify({ membershipType, membershipYear })
        });
    },

    async requestMembership() {
        if (!this.user) throw new Error('Not logged in');
        const data = await apiFetch('/api/users/me/request-membership', {
            method: 'POST'
        });
        this.user.membershipStatus = data.membershipStatus;
        this.user.membershipYear = data.membershipYear;
        return data;
    },

    async deleteAccount(password: string) {
        if (!this.user) throw new Error('Not logged in');

        try {
            await apiFetch('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email: this.user.email, password })
            });
        } catch (error: any) {
            const status = error?.status ?? error?.response?.status;
            if (status === 401 || status === 403) {
                throw new Error('Incorrect password.', { cause: error });
            }
            // For other errors (network/server/etc.), rethrow so they can be handled upstream
            throw error;
        }

        const data = await apiFetch(`/api/users/${this.user.id}`, {
            method: 'DELETE'
        });

        this.logout();
        return data;
    },

    async logout() {
        this.user = null;
        try {
            await apiFetch('/api/auth/logout', { method: 'POST' });
        } catch {
            // Ignore network errors — user is still logged out client-side
        }
    },

    getUser() {
        return this.user;
    }
};
export { adminApi, committeeApi, gearApi, votingApi };
export type { GearItem, GearRequest } from './lib/api/gear';
export type { Candidate, Referendum } from './lib/api/voting';
