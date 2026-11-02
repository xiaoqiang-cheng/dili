import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupDetail, GroupMessage } from '../shared/types';
import { api } from './api';
import { HistoryCache, HistoryRequests, historyRefresh } from './history-refresh';

function merge(previous: GroupDetail, page: GroupDetail, older = false): GroupDetail {
  const messages = new Map(previous.messages.map(message => [message.id, message]));
  for (const message of page.messages) {
    const existing = messages.get(message.id);
    // Changes to unloaded older messages must not create holes in the page.
    if (!older && !existing && previous.page?.before && (message.sequence ?? 0) < previous.page.before) continue;
    if (!existing || (message.revision ?? 0) >= (existing.revision ?? 0)) messages.set(message.id, message);
  }
  const replaced = new Set(page.messages.filter(message => messages.get(message.id) === message).map(message => message.id));
  const deliveries = [...previous.deliveries.filter(delivery => !replaced.has(delivery.messageId)), ...page.deliveries.filter(delivery => replaced.has(delivery.messageId))];
  return {
    ...previous,
    group: page.group.updatedAt >= previous.group.updatedAt ? page.group : previous.group,
    messages: [...messages.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)), deliveries,
    revision: older ? previous.revision : page.revision,
    page: page.page && { total: Math.max(previous.page?.total ?? 0, page.page.total), before: older ? page.page.before : previous.page?.before ?? null },
  };
}

/** A bounded HTTP page on entry, cursored changes afterward, explicit older pages.
 * Both request generation and per-message revisions protect navigation races. */
export function useGroupHistory(id: string | null, revision: string | undefined, reconnect: number, instanceId?: string) {
  const key = instanceId && id ? JSON.stringify([instanceId, id]) : null;
  const [view, setView] = useState<{ key: string | null; detail: GroupDetail | null }>({ key: null, detail: null });
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshRound, setRefreshRound] = useState(0);
  const current = useRef<GroupDetail | null>(null);
  const cache = useRef(new HistoryCache<GroupDetail>());
  const requests = useRef(new HistoryRequests<GroupDetail>());
  const activeKey = useRef<string | null>(null);
  const refresh = useRef<ReturnType<typeof historyRefresh> | null>(null);
  const generation = useRef(0);
  const olderRequest = useRef(false);
  const commit = useCallback((value: GroupDetail) => {
    current.current = value; setView({ key: activeKey.current, detail: value });
  }, []);
  useEffect(() => {
    const version = ++generation.current;
    activeKey.current = key;
    const saved = key ? cache.current.get(key) : null;
    current.current = saved; setView({ key, detail: saved }); setError(''); setLoadingOlder(false); olderRequest.current = false;
    if (!id || !instanceId) return;
    const worker = historyRefresh(async () => {
      let since = current.current?.group.id === id ? current.current.revision : undefined;
      do {
        const cursor = since;
        const page = await requests.current.read(JSON.stringify([key, cursor ?? null]), async () => {
          const page = await api<GroupDetail>(`/groups/${id}${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`);
          // Keep successful reads even after navigation. Never let an older
          // response replace a newer cache revision or cross an instance key.
          const saved = cache.current.get(key!);
          if (!saved || Date.parse(page.revision!) >= Date.parse(saved.revision!)) {
            cache.current.put(key!, saved ? merge(saved, page) : page);
          }
          return page;
        });
        if (version !== generation.current) return;
        const previous = current.current;
        const next = previous && previous.group.id === id && since ? merge(previous, page) : page;
        commit(next);
        cache.current.put(key!, next);
        setError('');
        since = page.nextSince ?? undefined;
      } while (since);
    }, cause => { if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); });
    refresh.current = worker;
    return () => { worker.stop(); refresh.current = null; generation.current++; };
  }, [id, instanceId, key, commit]);
  useEffect(() => {
    if (id && revision) refresh.current?.request();
  }, [id, revision, reconnect, refreshRound, instanceId]);
  const loadOlder = useCallback(async () => {
    const previous = current.current;
    if (!id || previous?.group.id !== id || !previous.page?.before || olderRequest.current) return;
    const version = generation.current;
    olderRequest.current = true; setLoadingOlder(true);
    try {
      const page = await api<GroupDetail>(`/groups/${id}?before=${previous.page.before}`);
      if (version !== generation.current || current.current?.group.id !== id) return;
      // An in-flight older page may precede a delta that skipped this unloaded
      // range. Replay changes since the request began after installing the page.
      commit({ ...merge(current.current, page, true), revision: previous.revision });
      setRefreshRound(value => value + 1); setError('');
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : '无法读取历史'); }
    finally { if (version === generation.current) { olderRequest.current = false; setLoadingOlder(false); } }
  }, [id, commit]);
  const readSource = useCallback((messageId: string) => api<GroupMessage>(`/groups/${id}/messages/${encodeURIComponent(messageId)}`), [id]);
  // Resolve the selected group's reading material in this render, not after
  // paint. A cache hit must never mount the blocking loading state first.
  const detail = view.key === key ? view.detail : key ? cache.current.get(key) : null;
  return { detail, error: activeKey.current === key ? error : '', loadOlder, loadingOlder: activeKey.current === key && loadingOlder, readSource };
}
