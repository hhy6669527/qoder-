import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, ArrowRight, BookOpen, Check, ChevronDown, Clock3, Copy, DoorOpen, Eye, Flag, Lightbulb, Link, LoaderCircle, LockKeyhole, MessageCircle, Quote, RotateCcw, Send, Users } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Command, GameView, RevealedRecord, Role } from '../shared/types';
import { Avatar, Choice, Kicker, Primary, relations, Secondary, StoryArt, topics } from './ui';
import { readEchoes } from './api';
import { isLocalPreview } from './environment';

type Props = { view: GameView; busy: boolean; command: (c: Command) => void; back: () => void; copy: (text: string) => Promise<void> };
export default function Game({ view, busy, command, back, copy }: Props) {
  const [leave, setLeave] = useState(false);
  const [revealStep, setRevealStep] = useState(view.mode === 'duo' ? 2 : 0);
  useEffect(() => { if (['briefing', 'reveal', 'repair', 'closed'].includes(view.phase)) window.scrollTo({ top: 0 }); }, [view.phase]);
  const own = view.ownRole;
  const partner = view.role === 'A' ? 'B' : 'A';
  const name = (role: Role) => view.story.cast[role].name;
  const invitation = `${location.origin}${location.pathname}#join/${view.id}`;
  const isRevealed = ['reveal', 'repair'].includes(view.phase);
  return <div className="game-container">
    <div className="game-topline"><button className="text-button" onClick={back}><ArrowLeft size={16}/>故事馆</button><span>{view.mode === 'solo' ? '一个人，换个座位' : '两个人，交换世界'}<span className="dot-separator">·</span>{relations[view.story.relation].label}</span><button className="text-button leave-button" onClick={() => setLeave(true)}><DoorOpen size={16}/>结束本局</button></div>
    <div className="game-title-row"><div><Kicker>STORY {view.story.number} / {topics[view.story.topic].label}</Kicker><h1>{view.story.title}</h1></div><div className="game-progress" aria-label="故事进度">{['各自入座', '三轮对话', '交换世界'].map((text, i) => <span key={text} className={(isRevealed ? 2 : view.phase === 'playing' ? 1 : 0) >= i ? 'reached' : ''}><i>{i + 1}</i>{text}</span>)}</div></div>
    {view.phase === 'closed' ? <div className="empty-state"><DoorOpen size={36}/><h2>这一次，先到这里。</h2><p>房间已结束。可以回故事馆，重新选一件小事。</p><Primary onClick={back}>回到故事馆<ArrowRight size={17}/></Primary></div>
    : view.phase === 'waiting' ? <div className="waiting-layout"><div className="waiting-art"><StoryArt relation={view.story.relation} featured/></div><section className="waiting-card"><span className="circle-symbol"><Users size={27}/></span><Kicker>A SEAT FOR SOMEONE</Kicker><h2>故事的另一边，<br/>还空着一个座位。</h2><p>把邀请发给一位朋友。你们看见的背景不同，先别偷看彼此的屏幕。</p><div className="seat-pair"><div><Avatar role={view.role} name={own.name}/><span>{own.name}<small>你已入座</small></span><Check size={16}/></div><div className="empty-seat"><span className="seat-placeholder">?</span><span>{name(partner)}<small>等待另一位玩家</small></span></div></div><label htmlFor="invite-link" className="field-label">邀请链接 · 不含你的私密身份</label><div className="copy-field"><input id="invite-link" value={invitation} readOnly onFocus={e => e.target.select()}/><button aria-label="复制邀请链接" onClick={() => void copy(invitation)}><Copy size={17}/></button></div><div className="room-detail"><span>房间码 <b>{view.id}</b></span><span><Clock3 size={13}/>24 小时有效</span></div><div className="local-note"><Link size={16}/><p>{isLocalPreview ? '当前为本地测试版，链接仅限本机访问。可复制到另一浏览器或无痕窗口测试。' : '把上方链接发给朋友，对方用手机或电脑打开即可入座。请各自保留当前标签页，邀请链接不包含你的角色凭证。'}</p></div><p className="waiting-status" role="status"><LoaderCircle size={15} className="spin"/>对方加入后，这里会自动更新</p></section></div>
    : view.phase === 'briefing' ? <div className="briefing-layout"><section className="scene-intro"><StoryArt relation={view.story.relation} featured/><div className="scene-intro-copy"><span className="location-label">{view.story.location}</span><h2>事情，是这样开始的。</h2><p>{view.story.setup}</p><div className="objective-box"><Flag size={18}/><div><small>你们共同的小目标</small><p>{view.story.objective}</p></div></div></div></section><section className="private-card"><div className="private-top"><span><LockKeyhole size={14}/>只属于你的这一面</span><span>角色 {view.role}</span></div><Avatar role={view.role} name={own.name} large/><h2>这一次，你是{own.name}。</h2><p className="identity">{own.identity}</p><p className="private-background">{own.background}</p><div className="own-goal"><small>你心里在意的是</small><p>{own.goal}</p></div><p className="fine-print">你可以选择角色此刻的本意，也可以说“我还没想清楚”。若对方选择问清楚，系统会展示你所选本意对应的解释。</p><Primary loading={busy} disabled={view.ready[view.role]} onClick={() => command({ action: 'ready' })}>{view.ready[view.role] ? '你已准备好，等另一边入座' : '我准备好了，进入故事'}{!view.ready[view.role] && <ArrowRight size={17}/>}</Primary><p className="under-button">{view.mode === 'solo' ? '另一位角色按预设分支回应 · 非实时 AI' : view.ready[partner] ? '对方已经准备好了' : '双方准备好后，一起开始'}</p></section></div>
    : view.phase === 'playing' ? <div className="play-layout"><aside className="role-sidebar"><div className="role-summary"><div className="private-top"><span><LockKeyhole size={13}/>你的视角</span><span>{view.role}</span></div><Avatar role={view.role} name={own.name} large/><h2>{own.name}</h2><p>{own.identity}</p><div className="role-goal"><small>此刻在意</small><p>{own.goal}</p></div><details><summary>再看一眼我的背景<ChevronDown size={14}/></summary><p>{own.background}</p></details></div><div className="side-objective"><Flag size={16}/><small>别忘了这件小事</small><p>{view.story.objective}</p></div><div className="partner-state"><span className={`presence-dot ${view.partnerOnline ? 'online' : ''}`}/>{view.mode === 'solo' ? '另一位角色 · 剧情分支' : view.partnerOnline ? '另一位玩家在线' : '对方暂离，保留进度等待重连'}</div></aside><section className="conversation-panel"><div className="conversation-header"><span><MessageCircle size={17}/>{view.round?.title || '等一句回应'}</span><span>第 {view.roundIndex + 1} / 3 幕</span></div>
      <div className="conversation-scroll"><div className="scene-caption">{view.round?.leadIn || view.round?.prompt}</div>
        {view.records.map((record, i) => <div key={`${record.index}-${i}`} className="transcript-pair"><div className={`bubble-line ${record.speaker === view.role ? 'mine' : ''}`}><Avatar role={record.speaker} name={name(record.speaker)}/><div><small>{name(record.speaker)}</small><p>{record.text}</p></div></div>{record.asked && record.clarification && <div className="clarification-transcript"><MessageCircle size={13}/>问清楚以后：{record.clarification}</div>}{record.reply && <div className={`bubble-line ${record.speaker !== view.role ? 'mine' : ''}`}><Avatar role={record.speaker === 'A' ? 'B' : 'A'} name={name(record.speaker === 'A' ? 'B' : 'A')}/><div><small>{name(record.speaker === 'A' ? 'B' : 'A')}</small><p>{record.reply}</p></div></div>}</div>)}
        {view.round?.incoming && !view.records.some(r => r.index === view.roundIndex && r.text === view.round?.incoming?.text) && <div className="bubble-line"><Avatar role={view.round.speaker} name={name(view.round.speaker)}/><div><small>{name(view.round.speaker)}</small><p>{view.round.incoming.text}</p></div></div>}
        {view.stage === 'wait' ? <div className="turn-wait" role="status"><span className="typing-dots"><i/><i/><i/></span><h3>另一边正在斟酌这句话。</h3><p>此时不展示对方的本意。等双方都说完，再一起揭晓。</p></div> : <ActiveRound key={`${view.id}-${view.roundIndex}-${view.stage}`} view={view} busy={busy} command={command}/>}
      </div></section></div>
    : view.phase === 'repair' ? <Repair view={view} busy={busy} command={command}/>
    : view.phase === 'reveal' ? <Reveal key={view.id} view={view} busy={busy} command={command} back={back} copy={copy} revealStep={revealStep} setRevealStep={setRevealStep}/> : null}
    <Dialog open={leave} onOpenChange={setLeave}><DialogContent><DialogHeader><DialogTitle>要合上这篇故事吗？</DialogTitle><DialogDescription>{view.mode === 'duo' ? '结束会关闭整个房间，另一位玩家也将无法继续。只想暂时离开，可以返回故事馆，稍后继续。' : '结束后不能继续本局。只想暂时离开，可以返回故事馆，保留进度。'}</DialogDescription></DialogHeader><div className="dialog-actions"><Secondary onClick={() => setLeave(false)}>继续故事</Secondary><Primary loading={busy} onClick={() => { command({ action: 'leave' }); setLeave(false); }}>结束本局</Primary></div></DialogContent></Dialog>
  </div>;
}

function ActiveRound({ view, busy, command }: Pick<Props, 'view' | 'busy' | 'command'>) {
  const [intent, setIntent] = useState('');
  const [line, setLine] = useState('');
  const [guess, setGuess] = useState('');
  const [response, setResponse] = useState<'accept' | 'boundary' | ''>('');
  const [step, setStep] = useState(0);
  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => { focusRef.current?.focus({ preventScroll: true }); }, [step]);
  const round = view.round;
  if (!round) return null;
  return <div className="decision-area rise" ref={focusRef} tabIndex={-1}>
    <p className="round-prompt">{round.prompt}</p>
    {view.stage === 'compose' ? <>
      <div className="decision-eyebrow"><LockKeyhole size={13}/>你心里想的，暂时只让自己知道<span>{step + 1} / 2</span></div>
      <h3>{step === 0 ? '此刻，你最想表达什么？' : '你会把哪句话说出口？'}</h3>
      <p className="decision-note">{step === 0 ? '这是你给角色选择的本意，不是系统替你读心。' : '同一个本意，也可能被不同的说法带向不同的地方。'}</p>
      {step === 0 ? <><div className="choice-list">{round.intents?.map(option => <Choice key={option.id} selected={intent === option.id} onClick={() => setIntent(option.id)} disabled={busy}>{option.label}</Choice>)}</div><Primary disabled={!intent || busy} onClick={() => setStep(1)}>接下来，选一句说法<ArrowRight size={16}/></Primary></> : <><div className="selected-intent"><LockKeyhole size={13}/>我的本意：{round.intents?.find(i => i.id === intent)?.label}<button onClick={() => setStep(0)}>修改</button></div><div className="choice-list">{round.lines?.map(option => <Choice key={option.id} selected={line === option.id} onClick={() => setLine(option.id)} disabled={busy}>“{option.text}”</Choice>)}</div><Primary loading={busy} disabled={!line} onClick={() => command({ action: 'compose', intentId: intent, lineId: line })}>把这句话说出口<Send size={16}/></Primary></>}
    </> : <>
      <div className="decision-eyebrow"><HeadphoneGlyph/>这句话，到了你这一边</div><h3>你觉得，对方想表达什么？</h3><p className="decision-note">你记录的是自己的理解，不是猜一道标准答案。</p>
      {round.incoming?.clarification ? <div className="clarification-card" role="status"><span><Lightbulb size={16}/>你选择了问清楚</span><p>{round.incoming.clarification}</p><small>{view.mode === 'duo' ? '这是对方选定本意时预先确认的解释。' : '这是故事角色预先设定的解释。'}</small></div> : <button className="clarify-button" disabled={busy} onClick={() => command({ action: 'clarify' })}><MessageCircle size={17}/><span>先问一句：“你具体指的是？”<small>不必急着猜，可以补上缺失的信息</small></span><ArrowRight size={16}/></button>}
      <div className="choice-list">{round.interpretations?.map(option => <Choice key={option.id} selected={guess === option.id} onClick={() => setGuess(option.id)} disabled={busy}>{option.label}</Choice>)}</div>
      <h4 className="response-title">然后，你会怎么回应？</h4><div className="choice-list response-options">{(['accept', 'boundary'] as const).map(key => <Choice key={key} selected={response === key} onClick={() => setResponse(key)} disabled={busy}>{round.replies?.[key]}</Choice>)}</div><Primary loading={busy} disabled={!guess || !response} onClick={() => response && command({ action: 'interpret', guessId: guess, response })}>留下我的理解，继续<ArrowRight size={16}/></Primary>
    </>}
  </div>;
}
function HeadphoneGlyph() { return <Eye size={13}/>; }

function Reveal({ view, busy, command, back, copy, revealStep, setRevealStep }: Props & { revealStep: number; setRevealStep: (step: number) => void }) {
  const data = view.reveal;
  const swapped = revealStep >= 1;
  const opened = revealStep >= 2;
  if (!data) return null;
  const opposite = view.role === 'A' ? 'B' : 'A';
  const other = data.roles[opposite];
  const firstDifferent = data.records.find(r => !r.matched);
  if (!opened) return <section className="perspective-reveal rise"><div className="reveal-side-art"><StoryArt relation={view.story.relation} featured/><div className="perspective-label"><ArrowLeftRight size={21}/><span>你看到的，<br/>一直只是故事的一半。</span></div></div><div className="perspective-copy"><Kicker>THE OTHER SIDE OF THE STORY</Kicker><h2>{swapped ? `现在，坐到${other.name}的位置。` : '如果，换个座位呢？'}</h2>{!swapped ? <><p>刚才，你带着{view.ownRole.name}的处境做了选择。<br/>但对话的另一边，也有你不知道的日常。</p><div className="sealed-letter"><LockKeyhole size={24}/><span>{other.name}没说出口的背景</span></div><Primary onClick={() => setRevealStep(1)}>坐到另一边<ArrowLeftRight size={17}/></Primary></> : <><div className="revealed-person"><Avatar role={opposite} name={other.name} large/><span><b>{other.name}</b><small>{other.identity}</small></span></div><blockquote>{other.background}</blockquote><div className="own-goal"><small>对方在意的是</small><p>{other.goal}</p></div><p className="fine-print">知道原因，不代表你必须同意。带着这些新信息，再看刚才的几句话。</p><Primary loading={busy} onClick={() => { setRevealStep(2); command({ action: 'repair', index: 1 }); }}>替{other.name}换一句话<ArrowLeftRight size={17}/></Primary><button className="text-button" onClick={() => setRevealStep(2)}>先看完整双轨回放<ArrowRight size={15}/></button></>}</div></section>;
  return <div className="replay-layout rise"><section className="replay-intro"><span className="circle-symbol"><ArrowLeftRight size={26}/></span><Kicker>OUR TWO SIDES, FINALLY TOGETHER</Kicker><h2>{firstDifferent ? '原来，我们从这里走岔了。' : '这一次，你们听见了彼此。'}</h2><p>没有谁的情商得分。只是把心里的话，和听到的话，放在一起。</p><div className="replay-stats"><span><b>03</b>段对话</span><span><b>{String(data.records.filter(r => r.asked).length).padStart(2, '0')}</b>次主动澄清</span><span><b>{String(data.records.filter(r => !r.matched).length).padStart(2, '0')}</b>处理解未重合</span></div></section>
    <div className="two-perspectives">{(['A', 'B'] as Role[]).map(role => <details key={role} className={`perspective-card role-${role}`}><summary><Avatar role={role} name={data.roles[role].name}/><span><b>{data.roles[role].name}的这一面</b><small>{data.roles[role].identity}</small></span><ChevronDown size={17}/></summary><p>{data.roles[role].background}</p><small>在意的是：{data.roles[role].goal}</small></details>)}</div>
    <div className="replay-heading"><h3>把意思，一句句对齐</h3><span>本意 → 表达 → 理解</span></div>
    {data.records.map(record => <ReplayRecord key={record.index} record={record} view={view} busy={busy} command={command} first={firstDifferent?.index === record.index}/>)}
    <section className="ending-note"><span className="kicker">这一局，停在这里</span><h3>{data.ending}</h3><div><LeafGlyph/><p>{data.takeaway}</p></div><small>{view.mode === 'solo' ? '这是虚构故事的分支结果，不预测现实中的关系。' : '这份回放只记录本局所选表达与理解，不是对两个人关系的评判。'}</small></section>
    <div className="replay-actions"><Primary onClick={back}>再遇见一件小事<ArrowRight size={17}/></Primary><Secondary onClick={() => void copy(`我在《同频不同词》体验了「${view.story.title}」。\n${data.takeaway}\n这不是关系测评，是一次交换视角的生活小剧场。`)}><Copy size={16}/>复制一份回声</Secondary><p><Check size={14}/>{readEchoes().some(e => e.id === view.id) ? '已留在「我的回声」，仅本浏览器可见' : '当前浏览器未保存回声，你仍可复制文案留存'}</p></div>
  </div>;
}
function LeafGlyph() { return <Lightbulb size={22}/>; }
function ReplayRecord({ record: r, view, busy, command, first }: { record: RevealedRecord; view: GameView; busy: boolean; command: Props['command']; first: boolean }) {
  const receiver = r.speaker === 'A' ? 'B' : 'A';
  return <article className={`replay-record ${first ? 'first-fork' : ''}`}><div className="record-top"><span>0{r.index + 1}<i/> {r.title}</span><span className={`record-badge ${r.matched ? 'matched' : ''}`}>{r.matched ? <><Check size={13}/>这句听到一起了</> : first ? '第一次理解分岔' : '理解尚未重合'}</span></div><div className="meaning-grid"><div><small>{view.story.cast[r.speaker].name} · 想表达</small><p>{r.intended}</p></div><div className="spoken-column"><small>实际说出口</small><blockquote>“{r.text}”</blockquote></div><div><small>{view.story.cast[receiver].name} · 听成了</small><p>{r.interpreted}</p></div></div>{r.asked && <p className="record-clarified"><MessageCircle size={14}/>这一轮先问清楚了：{r.clarification}</p>}<div className="record-insight"><p><Lightbulb size={16}/>{r.insight}</p>{(view.mode === 'solo' || r.speaker === view.role) && <button className="text-button" disabled={busy} onClick={() => command({ action: 'repair', index: r.index })}><RotateCcw size={14}/>{r.speaker === view.role ? '这句话，换个说法' : `坐到${view.story.cast[r.speaker].name}那边再试`}</button>}</div></article>;
}
function Repair({ view, busy, command }: Pick<Props, 'view' | 'busy' | 'command'>) {
  const repair = view.repair;
  const [line, setLine] = useState('');
  const [guess, setGuess] = useState('');
  if (!repair) return null;
  const isSender = view.mode === 'solo' || view.role === repair.speaker;
  const waiting = (repair.stage === 'compose' && !isSender) || (repair.stage === 'interpret' && isSender);
  return <section className="repair-panel rise"><span className="circle-symbol"><RotateCcw size={26}/></span><Kicker>ONE SENTENCE, ANOTHER POSSIBILITY</Kicker><h2>{view.mode === 'solo' && repair.speaker !== view.role ? `现在，替${view.story.cast[repair.speaker].name}说一句。` : '本意不变，换一种说法。'}</h2><p>{view.mode === 'solo' && repair.speaker !== view.role ? `带着对方的背景重新表达；这次由预设角色${view.ownRole.name}回应。` : '这是揭晓后的表达练习，不是重新测试默契；原来的记录不会被覆盖。'}</p><div className="repair-original"><small>刚才那句话</small><blockquote>“{repair.original.text}”</blockquote><span><LockKeyhole size={13}/>原本想表达：{repair.original.intended}</span></div>
    {waiting ? <div className="turn-wait" role="status"><LoaderCircle className="spin" size={22}/><h3>{repair.stage === 'compose' ? '等对方换一句说法' : '等对方重新写下理解'}</h3><p>双人练习必须由另一位玩家实际回应，不会由系统代答。</p></div> : repair.stage === 'compose' ? <><h3>这一次，你想怎么说？</h3><div className="choice-list">{repair.lines?.map(item => <Choice key={item.id} selected={line === item.id} disabled={busy} onClick={() => setLine(item.id)}>{item.text}</Choice>)}</div><Primary loading={busy} disabled={!line || line === repair.original.lineId} onClick={() => command({ action: 'repair-compose', lineId: line })}>用新的说法，再试一次<Send size={16}/></Primary></> : repair.stage === 'interpret' ? <><div className="repair-new"><small>对方换了一句</small><blockquote>“{repair.text}”</blockquote></div><h3>现在，你会怎么理解？</h3><div className="choice-list">{repair.interpretations?.map(item => <Choice key={item.id} selected={guess === item.id} disabled={busy} onClick={() => setGuess(item.id)}>{item.label}</Choice>)}</div><Primary loading={busy} disabled={!guess} onClick={() => command({ action: 'repair-interpret', guessId: guess })}>留下这一次的理解<ArrowRight size={16}/></Primary></> : <div className="repair-result"><span className="record-badge matched">{repair.matched ? '这次，意思更接近了' : '这次，理解仍有差异'}</span><div><small>换成</small><p>“{repair.text}”</p><small>听成</small><p>{repair.interpreted}</p></div><p className="fine-print">{view.mode === 'solo' ? '这是预设角色对新表达的分支回应，不代表现实中对方一定会这样理解。' : '这次结果来自另一位玩家的真实选择。意思没有重合，也可以继续讨论彼此在意的事。'}</p></div>}
    <button className="text-button repair-back" disabled={busy} onClick={() => command({ action: 'repair-end' })}><ArrowLeft size={15}/>回到原来的双轨回放</button>
  </section>;
}
