import { FormEvent } from 'react';
import { toErrorMessage } from '@everycal/core';
import { adminFetch } from '../lib/adminFetch';
import type { Account, ConfirmState, AdminRevokeAuthResponse } from './admin-types';

type AdminAccountsSectionProps = {
  accounts: Account[];
  enabledAdminCount: number;
  accountQuery: string;
  setAccountQuery: (q: string) => void;
  refreshAccounts: () => Promise<void>;
  refreshAudit: () => Promise<void>;
  user: { id: string } | null | undefined;
  openReasonModal: (options: Omit<ConfirmState, 'open' | 'reason' | 'loading'>) => void;
  pendingActionKey: string | null;
  setPendingActionKey: (key: string | null) => void;
  setStatus: (msg: string | null) => void;
  setError: (msg: string | null) => void;
};

export function AdminAccountsSection({
  accounts,
  enabledAdminCount,
  accountQuery,
  setAccountQuery,
  refreshAccounts,
  refreshAudit,
  user,
  openReasonModal,
  pendingActionKey,
  setPendingActionKey,
  setStatus,
  setError,
}: AdminAccountsSectionProps) {
  return (
    <section id='accounts' className='settings-section'>
      <div className='settings-card'>
      <h2 className='settings-section-title mb-1'>Accounts</h2>
      <p className='text-sm text-muted mb-1'>Search users, disable compromised accounts, and restore access when resolved.</p>
      <form className='flex gap-1 mb-1' onSubmit={(e: FormEvent) => { e.preventDefault(); refreshAccounts().catch((err) => setError(toErrorMessage(err, 'Failed to refresh accounts'))); }}>
        <input aria-label='Search accounts by username' placeholder='Search username' value={accountQuery} onChange={(e) => setAccountQuery(e.target.value)} />
        <button className='btn btn-primary' type='submit'>Search</button>
      </form>
      <ul className='admin-record-list admin-record-list--accounts' role='list' aria-label='Accounts'>
        {accounts.map((a) => {
          const disableBlockedReason = a.id === user?.id
            ? 'You cannot disable your own admin account.'
            : (a.is_admin && !a.is_disabled && enabledAdminCount <= 1)
                ? 'You cannot disable the last enabled admin account.'
                : null;
          return (
            <li key={a.id} className='admin-record-row'>
              <div className='admin-record-main'>
                <p className='admin-record-title'>
                  @{a.username}
                  {a.is_admin ? <span className='admin-record-pill is-accent'>Admin</span> : null}
                </p>
                <p className='admin-record-subtitle'>{a.id}</p>
                {disableBlockedReason ? <p className='text-sm text-muted'>{disableBlockedReason}</p> : null}
              </div>
              <div className='admin-record-meta' aria-label='Account attributes'>
                <span className={`admin-record-pill ${a.is_disabled ? 'is-danger' : 'is-success'}`}>{a.is_disabled ? 'Disabled' : 'Active'}</span>
                {a.is_locked_out ? <span className='admin-record-pill is-danger'>Locked out</span> : null}
              </div>
              <div className='admin-record-actions'>
                <button
                  className='btn btn-ghost btn-sm'
                  disabled={pendingActionKey === `revoke-auth:${a.id}`}
                  onClick={() => {
                    openReasonModal({
                      title: `Revoke auth for @${a.username}`,
                      description: 'This revokes all sessions and API keys for the account.',
                      reasonLabel: 'Revocation reason',
                      actionLabel: 'Revoke auth',
                      actionClassName: 'btn-danger',
                      requireReason: true,
                      onConfirm: async (reason) => {
                        setPendingActionKey(`revoke-auth:${a.id}`);
                        try {
                          const data = await adminFetch<AdminRevokeAuthResponse>(`/api/v1/admin/security/accounts/${encodeURIComponent(a.id)}/revoke-auth`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ reason }),
                          });
                          setStatus(`Revoked auth for @${a.username} (sessions: ${data.revokedSessions}, api keys: ${data.revokedApiKeys})`);
                        } finally {
                          setPendingActionKey(null);
                        }
                        await refreshAudit();
                      },
                    });
                  }}
                >Revoke auth</button>
                {a.is_locked_out ? (
                  <button
                    className='btn btn-ghost btn-sm'
                    disabled={pendingActionKey === `reset-lockout:${a.username}`}
                    onClick={() => {
                      openReasonModal({
                        title: `Reset lockout for @${a.username}`,
                        description: 'This clears failed login attempts and lock timers for this username.',
                        reasonLabel: 'Reset reason',
                        actionLabel: 'Reset lockout',
                        requireReason: true,
                        onConfirm: async (reason) => {
                          setPendingActionKey(`reset-lockout:${a.username}`);
                          try {
                            await adminFetch(`/api/v1/admin/security/login-lockouts/${encodeURIComponent(a.username)}/reset`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ reason }),
                            });
                            setStatus(`Reset lockout state for @${a.username}`);
                          } finally {
                            setPendingActionKey(null);
                          }
                          await refreshAccounts();
                          await refreshAudit();
                        },
                      });
                    }}
                  >Reset lockout</button>
                ) : null}
                {a.is_disabled ? (
                  <button
                    className='btn btn-ghost btn-sm'
                    disabled={pendingActionKey === `enable:${a.id}`}
                    onClick={() => {
                      openReasonModal({
                        title: `Enable @${a.username}`,
                        description: 'This restores account access for new sessions.',
                        reasonLabel: 'Enable reason',
                        actionLabel: 'Enable account',
                        requireReason: true,
                        onConfirm: async (reason) => {
                          setPendingActionKey(`enable:${a.id}`);
                          try {
                            await adminFetch(`/api/v1/admin/accounts/${a.id}/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
                          } finally {
                            setPendingActionKey(null);
                          }
                          setStatus(`Enabled @${a.username}`);
                          await refreshAccounts();
                          await refreshAudit();
                        },
                      });
                    }}
                  >Enable</button>
                ) : (
                  <button
                    className='btn btn-danger btn-sm'
                    disabled={pendingActionKey === `disable:${a.id}` || !!disableBlockedReason}
                    onClick={() => {
                      if (disableBlockedReason) return;
                      openReasonModal({
                        title: `Disable @${a.username}`,
                        description: 'This revokes active sessions and API keys, and blocks new authentication.',
                        reasonLabel: 'Disable reason',
                        actionLabel: 'Disable account',
                        actionClassName: 'btn-danger',
                        requireReason: true,
                        onConfirm: async (reason) => {
                          setPendingActionKey(`disable:${a.id}`);
                          try {
                            await adminFetch(`/api/v1/admin/accounts/${a.id}/disable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
                          } finally {
                            setPendingActionKey(null);
                          }
                          setStatus(`Disabled @${a.username}`);
                          await refreshAccounts();
                          await refreshAudit();
                        },
                      });
                    }}
                  >Disable</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!accounts.length ? <p className='text-sm text-muted'>No accounts found for this query.</p> : null}
      </div>
    </section>
  );
}
