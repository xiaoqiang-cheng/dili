import { useState } from 'react';
import type { GroupCost } from '../shared/group-cost';
import { formatTokens } from '../shared/usage';
import { t } from '../shared/i18n';

const MEMBER_LIMIT = 12;

/**
 * Group cost is listed per task because a member's native number covers its
 * whole session, so a group total alone would hide which task paid for what.
 * Unknown members stay visible: hiding them would make the sum look complete.
 */
export default function GroupCostPanel({ cost }: { cost: GroupCost | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  if (!cost || !cost.tasks.length) return null;
  const tasks = expanded ? cost.tasks : cost.tasks.slice(-MEMBER_LIMIT);
  const ordered = [...tasks].reverse();
  return (
    <details className="group-cost" open={expanded} onToggle={event => setExpanded((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span>{t('usage.groupTitle')}</span>
        <small className="usage-value" title={t('usage.groupNote')}>
          {cost.totalTokens === null ? t('usage.unknown') : formatTokens(cost.totalTokens)}
          {cost.unknown ? ` · ${t('usage.groupUnknown', { n: cost.unknown })}` : ''}
          {cost.partial ? ` · ${t('usage.groupPartial')}` : ''}
        </small>
      </summary>
      <ul className="group-cost-tasks">
        {ordered.map(task => (
          <li key={task.deliveryId} className={task.totalTokens === null ? 'usage-missing' : undefined}>
            <code>{task.key}</code>
            <span>{task.memberName}</span>
            {task.kind === 'briefing' && <em>入群说明</em>}
            <small>{task.totalTokens === null ? t('usage.unknown') : `合计 ${formatTokens(task.totalTokens)} · 输入 ${formatTokens(task.inputTokens ?? 0)} · 输出 ${formatTokens(task.outputTokens ?? 0)}`}</small>
            {task.partial && <small className="usage-missing">{t('usage.partial')}</small>}
          </li>
        ))}
      </ul>
      <p className="group-cost-note">{t('usage.groupNote')}</p>
    </details>
  );
}
