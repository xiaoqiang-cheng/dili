import { useEffect, useState } from 'react';
import { ChevronDown, Pin } from 'lucide-react';
import { readMachines } from './machine-store';
import { machineHome, openMachine, publicMachineUrl } from './machine-links';
import { appUrl } from './urls';
import { readWorkspaceRoute, workspaceHash } from './navigation';

type Visit = { hash: string; time: number };
const key = 'dili.machine-visits.v1';
function visits(): Record<string, Visit> {
  try { return JSON.parse(sessionStorage.getItem(key) || '{}') || {}; } catch { return {}; }
}
export default function MachineSwitcher() {
  const current = publicMachineUrl(new URL(appUrl('/'), location.origin).href);
  const [machines, setMachines] = useState(readMachines);
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [recent, setRecent] = useState(visits);
  const home = machineHome();
  useEffect(() => {
    const save = () => {
      const next = { ...visits(), [current]: { hash: workspaceHash(readWorkspaceRoute(location.hash)), time: Date.now() } };
      try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Navigation works without storage. */ }
      setRecent(next);
    };
    const sync = () => setMachines(readMachines());
    save();
    window.addEventListener('hashchange', save);
    window.addEventListener('pagehide', save);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('hashchange', save); window.removeEventListener('pagehide', save); window.removeEventListener('storage', sync); };
  }, [current]);
  if (!home || !machines.length) return null;
  const ordered = [...machines].sort((a, b) => (recent[publicMachineUrl(b.url)]?.time || 0) - (recent[publicMachineUrl(a.url)]?.time || 0));
  const name = machines.find(machine => publicMachineUrl(machine.url) === current)?.name || '当前机器';
  const visible = expanded || pinned;
  return <div className="machine-switcher">
    <button className="machine-switch-toggle" aria-label="切换机器" aria-expanded={visible} onClick={() => { if (pinned) setPinned(false); setExpanded(!visible); }} title={name}><span>{name}</span><ChevronDown size={12} /></button>
    {visible && <nav className="machine-switch-tabs" aria-label="切换已添加机器">
      <div className="machine-switch-scroll">{ordered.map(machine => {
        const url = publicMachineUrl(machine.url);
        const target = new URL(openMachine(url, home));
        if (recent[url]?.hash) target.hash = workspaceHash(readWorkspaceRoute(recent[url].hash));
        return <a key={url} href={target.href} aria-current={url === current ? 'page' : undefined} title={machine.url} onClick={event => {
          setExpanded(false);
          if (url === current) event.preventDefault();
        }}>{machine.name}</a>;
      })}</div>
      <button className="machine-switch-pin" aria-label="固定机器切换条" aria-pressed={pinned} onClick={() => { setPinned(!pinned); setExpanded(false); }} title="固定展开"><Pin size={14} /></button>
    </nav>}
  </div>;
}
