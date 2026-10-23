import { useEffect, useId, useState, type RefObject } from 'react';
import { BrainCircuit, ChevronRight, Settings2, ShieldCheck } from 'lucide-react';
import AgentChatPopover from './AgentChatPopover';

const commands = [
  { id: 'settings', label: '会话设置', description: '查看当前 Agent 的原生设置', icon: Settings2 },
  { id: 'model', label: '模型', description: '选择当前会话使用的模型', icon: BrainCircuit },
  { id: 'permissions', label: '权限', description: '调整当前会话的权限模式', icon: ShieldCheck },
] as const;
export type ChatCommand = typeof commands[number]['id'];

export default function AgentChatCommands({ text, anchor, enabled, select }: {
  text: string; anchor: RefObject<HTMLTextAreaElement | null>; enabled: boolean; select(command: ChatCommand): void;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const matches = commands.filter(command => ('/' + command.id).startsWith(text));
  const visible = enabled && !dismissed && /^\/[a-z]*$/.test(text) && !!matches.length;
  useEffect(() => { setActive(0); setDismissed(false); }, [text]);
  const index = Math.min(active, matches.length - 1);
  useEffect(() => {
    const input = anchor.current;
    if (!input || !visible) return;
    input.setAttribute('aria-controls', id);
    input.setAttribute('aria-activedescendant', `${id}-${index}`);
    input.setAttribute('aria-autocomplete', 'list');
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        setActive(previous => (previous + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
      } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation(); select(matches[index].id);
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setDismissed(true);
      }
    };
    input.addEventListener('keydown', key);
    return () => {
      input.removeEventListener('keydown', key);
      input.removeAttribute('aria-controls'); input.removeAttribute('aria-activedescendant'); input.removeAttribute('aria-autocomplete');
    };
  }, [anchor, visible, id, index, text, enabled, select]);
  if (!visible) return null;
  return <AgentChatPopover anchor={anchor} id={id} className="agent-chat-commands" role="listbox" label="原生会话命令" close={() => setDismissed(true)}>
    <div className="agent-chat-commands-heading"><span>会话快捷命令</span><span>↑ ↓ 选择 · Enter 打开</span></div>
    {matches.map(({ id: command, label, description, icon: Icon }, position) => <button type="button" role="option" id={`${id}-${position}`} aria-selected={position === index} className="agent-chat-command" key={command} onMouseEnter={() => setActive(position)} onClick={() => select(command)}>
      <span className="agent-chat-command-icon"><Icon size={15} /></span><span className="agent-chat-command-copy"><strong>/{command} <small>{label}</small></strong><em>{description}</em></span><ChevronRight size={14} />
    </button>)}
  </AgentChatPopover>;
}
