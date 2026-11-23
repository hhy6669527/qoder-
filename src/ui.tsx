import type { ReactNode } from 'react';
import { ArrowUpRight, Check, Coffee, Compass, Heart, House, MessagesSquare, HandHeart, Users, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Relation, Role, StorySummary, Topic } from '../shared/types';

export const relations: Record<Relation, { label: string; subtitle: string; icon: typeof Users; color: string }> = {
  friends: { label: '朋友间', subtitle: '熟悉，也有没说出口的事', icon: Users, color: 'sage' },
  family: { label: '家人间', subtitle: '把关心，换一种方式听见', icon: House, color: 'peach' },
  couple: { label: '情侣间', subtitle: '靠近彼此，也留一点空间', icon: Heart, color: 'rose' },
};
export const topics: Record<Topic, { label: string; icon: typeof Coffee }> = {
  meal: { label: '一起吃饭', icon: Coffee }, travel: { label: '出去走走', icon: Compass },
  message: { label: '消息往来', icon: MessagesSquare }, help: { label: '帮个小忙', icon: HandHeart },
};
export function Mark() {
  return <svg className="brand-mark" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true"><path d="M4 7a4 4 0 0 1 4-4h17a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H14l-7 5v-5a4 4 0 0 1-3-4Z" fill="currentColor"/><path d="M14 13h14a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-1v4l-6-4h-7a4 4 0 0 1-4-4V17a4 4 0 0 1 4-4Z" fill="#df9271" stroke="#f7f6f0" strokeWidth="2"/><path d="M16 20h10m-10 4h6" stroke="#fffaf2" strokeWidth="2" strokeLinecap="round"/></svg>;
}
export function Avatar({ role, name, large = false }: { role: Role; name: string; large?: boolean }) {
  return <span className={`avatar avatar-${role} ${large ? 'avatar-large' : ''}`} aria-label={`${name}，角色${role}`}>{name.slice(-1)}</span>;
}
export function Primary({ children, loading, ...props }: React.ComponentProps<typeof Button> & { loading?: boolean }) {
  return <Button {...props} className={`primary ${props.className || ''}`} disabled={props.disabled || loading}>{loading && <LoaderCircle className="spin" size={17}/>} {children}</Button>;
}
export function Secondary({ children, ...props }: React.ComponentProps<typeof Button>) {
  return <Button {...props} variant="outline" className={`secondary ${props.className || ''}`}>{children}</Button>;
}
export function Kicker({ children }: { children: ReactNode }) { return <p className="kicker">{children}</p>; }
export function StoryArt({ relation, topic, featured = false }: { relation: Relation; topic?: Topic; featured?: boolean }) {
  const Icon = topic ? topics[topic].icon : MessagesSquare;
  return <div className={`story-art art-${relation} ${featured ? 'art-featured' : ''}`}>
    <img src={`/art/${relation}.webp`} alt={relation === 'friends' ? '朋友在街角咖啡馆聊天的手绘插画' : relation === 'family' ? '家人在餐桌旁相处的手绘插画' : '两个人在公园一起散步的手绘插画'} width="1536" height="1024" loading={featured ? 'eager' : 'lazy'}/>
    {!featured && <span className="art-topic"><Icon size={16}/>{topic && topics[topic].label}</span>}
  </div>;
}
export function StoryCard({ story, onOpen, completed }: { story: StorySummary; onOpen: (s: StorySummary) => void; completed: boolean }) {
  return <button className={`story-entry tone-${relations[story.relation].color}`} onClick={() => onOpen(story)} aria-label={`STORY ${story.number} ${story.title} ${topics[story.topic].label} ${completed ? '已体验' : story.duration}`}>
    <span className="entry-number">{story.number}</span><div className="entry-copy"><div className="entry-meta"><span>{topics[story.topic].label}</span><i/>{story.mood}</div><h4>{story.title}</h4><p>{story.subtitle}</p></div><div className="entry-end"><ArrowUpRight size={23}/><span>{completed ? <><Check size={12}/>已体验</> : '3–5 min'}</span></div>
  </button>;
}
export function Choice({ selected, children, hint, onClick, disabled }: { selected: boolean; children: ReactNode; hint?: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className={`choice ${selected ? 'is-selected' : ''}`} aria-pressed={selected} disabled={disabled} onClick={onClick}><span className="choice-dot">{selected && <Check size={13}/>}</span><span>{children}{hint && <small>{hint}</small>}</span></button>;
}
