import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';

type AnyObj = Record<string, any>;

export function AdminPage() {
  const { user } = useAuth();
  const [health, setHealth] = useState<AnyObj | null>(null);
  const [audit, setAudit] = useState<AnyObj[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.isAdmin) return;
    fetch('/api/v1/admin/health', { credentials: 'include' }).then(r => r.json()).then(setHealth).catch((e) => setError(String(e)));
    fetch('/api/v1/admin/audit-log', { credentials: 'include' }).then(r => r.json()).then(d => setAudit(d.items || [])).catch(() => {});
  }, [user?.isAdmin]);

  if (!user?.isAdmin) return <div className='empty-state mt-3'><h2>Forbidden</h2><p>Admin access is required.</p></div>;
  if (error) return <div className='empty-state mt-3'><h2>Error</h2><p>{error}</p></div>;

  return <div className='stack-md mt-3'>
    <h1>Admin Console</h1>
    <p>Navigation: Health · Accounts · Events · Federation · Scrapers · Security · Audit</p>
    <section className='card p-3'>
      <h2>System health + operations</h2>
      <pre>{JSON.stringify(health, null, 2)}</pre>
    </section>
    <section className='card p-3'>
      <h2>Quick actions</h2>
      <button className='btn-danger btn-sm' onClick={async()=>{await fetch(`/api/v1/admin/scrapers/trigger`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({dryRun:true})}); alert('queued')}}>Queue dry-run scraper cycle</button>
    </section>
    <section className='card p-3'>
      <h2>Audit trail</h2>
      <pre>{JSON.stringify(audit.slice(0, 20), null, 2)}</pre>
    </section>
  </div>;
}
