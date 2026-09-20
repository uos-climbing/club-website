import type { MembershipType, Session, SessionType, User } from '../../auth';
import { apiFetch } from './http';

export const adminApi = {
    async getAllUsers(): Promise<User[]> {
        const users = await apiFetch('/api/admin/users');
        return users.filter((u: User) => u.membershipStatus === 'pending');
    },

    async getAllUsersRaw(): Promise<User[]> {
        return apiFetch('/api/admin/users');
    },

    async getActiveMembers(): Promise<User[]> {
        const users = await apiFetch('/api/admin/users');
        return users.filter(
            (u: User) => u.membershipStatus === 'active' && u.email !== 'committee@sheffieldclimbing.org'
        );
    },

    async approveMember(id: string) {
        return apiFetch(`/api/admin/users/${id}/approve`, { method: 'POST' });
    },

    async rejectMember(id: string) {
        return apiFetch(`/api/admin/users/${id}/reject`, { method: 'POST' });
    },

    async promoteToCommittee(id: string) {
        return apiFetch(`/api/admin/users/${id}/promote`, { method: 'POST' });
    },

    async demoteToMember(id: string) {
        return apiFetch(`/api/admin/users/${id}/demote`, { method: 'POST' });
    },

    async deleteUser(id: string) {
        return apiFetch(`/api/users/${id}`, { method: 'DELETE' });
    },

    async approveMembershipRow(id: string) {
        return apiFetch(`/api/admin/memberships/${id}/approve`, { method: 'POST' });
    },

    async rejectMembershipRow(id: string) {
        return apiFetch(`/api/admin/memberships/${id}/reject`, { method: 'POST' });
    },

    async deleteMembershipRow(id: string) {
        return apiFetch(`/api/admin/memberships/${id}`, { method: 'DELETE' });
    },

    async setCommitteeRole(id: string, committeeRoles: string[]) {
        return apiFetch(`/api/admin/users/${id}/committee-role`, {
            method: 'POST',
            body: JSON.stringify({ committeeRoles })
        });
    },

    async getElectionsConfig() {
        return apiFetch('/api/admin/config/elections');
    },

    async setElectionsConfig(open: boolean) {
        return apiFetch('/api/admin/config/elections', {
            method: 'POST',
            body: JSON.stringify({ open })
        });
    },

    async sendTestEmail() {
        return apiFetch('/api/admin/test-email', { method: 'POST' });
    },

    async importSuRoster(raw: string) {
        return apiFetch('/api/admin/memberships/import-su-roster', {
            method: 'POST',
            body: JSON.stringify({ raw })
        });
    },

    async getSessions(): Promise<Session[]> {
        return apiFetch('/api/sessions');
    },

    async addSession(session: Omit<Session, 'id' | 'bookedSlots'>): Promise<Session> {
        return apiFetch('/api/sessions', {
            method: 'POST',
            body: JSON.stringify(session)
        });
    },

    async addSessions(sessions: Omit<Session, 'id' | 'bookedSlots'>[]): Promise<Session[]> {
        return apiFetch('/api/sessions/bulk', {
            method: 'POST',
            body: JSON.stringify({ sessions })
        });
    },

    async updateSession(id: string, updates: Partial<Session>): Promise<void> {
        return apiFetch(`/api/sessions/${id}`, {
            method: 'PUT',
            body: JSON.stringify(updates)
        });
    },

    async deleteSession(id: string) {
        return apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
    },

    async getMyBookings(): Promise<string[]> {
        return apiFetch('/api/sessions/me/bookings');
    },

    async bookSession(id: string) {
        return apiFetch(`/api/sessions/${id}/book`, { method: 'POST' });
    },

    async cancelSession(id: string) {
        return apiFetch(`/api/sessions/${id}/cancel`, { method: 'POST' });
    },

    async getSessionAttendees(id: string): Promise<User[]> {
        return apiFetch(`/api/sessions/${id}/attendees`);
    },

    async removeAttendee(sessionId: string, userId: string) {
        return apiFetch(`/api/sessions/${sessionId}/attendees/${userId}`, { method: 'DELETE' });
    },

    async getSessionTypes(): Promise<SessionType[]> {
        return apiFetch('/api/session-types');
    },

    async addSessionType(label: string): Promise<SessionType> {
        return apiFetch('/api/session-types', {
            method: 'POST',
            body: JSON.stringify({ label })
        });
    },

    async updateSessionType(id: string, label: string): Promise<SessionType> {
        return apiFetch(`/api/session-types/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ label })
        });
    },

    async deleteSessionType(id: string): Promise<void> {
        return apiFetch(`/api/session-types/${id}`, { method: 'DELETE' });
    },

    async getMembershipTypes(): Promise<MembershipType[]> {
        return apiFetch('/api/membership-types');
    },

    async addMembershipType(label: string, id?: string): Promise<MembershipType> {
        return apiFetch('/api/membership-types', {
            method: 'POST',
            body: JSON.stringify({ label, id })
        });
    },

    async updateMembershipType(id: string, label: string, deprecated?: boolean): Promise<MembershipType> {
        return apiFetch(`/api/membership-types/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ label, deprecated })
        });
    },

    async deleteMembershipType(id: string): Promise<void> {
        return apiFetch(`/api/membership-types/${id}`, { method: 'DELETE' });
    },

    async getAvailableRoles() {
        return apiFetch('/api/admin/committee-roles');
    },

    async addCommitteeRole(id: string, label: string) {
        return apiFetch('/api/admin/committee-roles', {
            method: 'POST',
            body: JSON.stringify({ id, label })
        });
    },

    async updateCommitteeRole(id: string, label: string) {
        return apiFetch(`/api/admin/committee-roles/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ label })
        });
    },

    async deleteCommitteeRole(id: string): Promise<void> {
        return apiFetch(`/api/admin/committee-roles/${id}`, { method: 'DELETE' });
    }
};
