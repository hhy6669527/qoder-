import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ArrowRight, BookOpen, Check, ChevronRight, CircleHelp, Clock3, Copy, Headphones, Heart, Leaf, LoaderCircle, Search, Shuffle, Sparkles, Users, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Command, GameView, Mode, Relation, Session, StorySummary, Topic } from '../shared/types';
import { activeSession, api, ApiError, forgetActive, loadSession, randomToken, readEchoes, requestId, saveEcho, saveSession } from './api';
import { Kicker, Mark, Primary, relations, Secondary, StoryArt, topics } from './ui';
import StoryLibrary, { type LibraryNavigation } from './StoryLibrary';
import Game from './Game';
import { isLocalPreview } from './environment';
import { clearAttempt, clearPending, getAttempt, loadPending, storePending, type Attempt, type PendingCommand } from './recovery';

const getRoute = () => window.location.hash.slice(1) || 'library';
function navigate(path: string) { window.location.hash = path === 'library' ? '' : path; }

export default function App() {
  const [route, setRoute] = useState(getRoute);
  const [stories, setStories] = useState<StorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const libraryNavigation = useRef<LibraryNavigation>({ category: null, hubScroll: 0, sceneScroll: 0, visited: false });
  const previousRoute = useRef(route);
  const [mode, setMode] = useState<Mode>('solo');
  const [selected, setSelected] = useState<StorySummary | null>(null);
  const [help, setHelp] = useState(false);
  const [joinDialog, setJoinDialog] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [view, setView] = useState<GameView | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [resume, setResume] = useState(activeSession);
  const [echoes, setEchoes] = useState(readEchoes);
  const [pollError, setPollError] = useState('');
  const createAttempt = useRef<Attempt | null>(null);
  const pendingCommand = useRef<PendingCommand | null>(null);
  const busyRef = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const storyTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const change = () => {
      if (previousRoute.current === 'library') {
        const saved = libraryNavigation.current;
        if (saved.category) saved.sceneScroll = window.scrollY;
        else saved.hubScroll = window.scrollY;
      }
      previousRoute.current = getRoute();
      setRoute(getRoute()); setError(''); setSelected(null); window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => { mainRef.current?.focus({ preventScroll: true }); }, [route]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  const loadCatalog = useCallback(async () => {
    setLoading(true); setCatalogError('');
    try { const result = await api.stories(); setStories(result.stories); }
    catch (e) { setCatalogError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const accept = useCallback((next: GameView) => {
    setView(old => !old || next.id !== old.id || next.revision >= old.revision ? next : old);
    if (next.reveal) {
      saveEcho(next);
      setEchoes(old => old.some(e => e.id === next.id) ? old : readEchoes());
      if (activeSession()?.roomId === next.id) { forgetActive(); setResume(null); }
    }
    if (next.phase === 'closed' && activeSession()?.roomId === next.id) { forgetActive(); setResume(null); }
  }, []);
  const roomId = route.startsWith('room/') ? route.split('/')[1] : '';
  const joinId = route.startsWith('join/') ? route.split('/')[1] : '';
  useEffect(() => {
    if (!roomId) { setSession(null); setPollError(''); setUncertain(false); pendingCommand.current = null; return; }
    const recovered = loadPending(roomId);
    pendingCommand.current = recovered; setUncertain(Boolean(recovered));
    const stored = loadSession(roomId);
    if (!stored) { navigate(`join/${roomId}`); return; }
    setSession(stored); setPollError(''); setView(old => old?.id === roomId ? old : null);
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; let lastPresence = 0;
    const poll = async () => {
      let again = true;
      try {
        const result = await api.read(stored);
        if (!cancelled) {
          accept(result.view); setPollError('');
          again = stored.mode === 'duo' && result.view.phase !== 'closed';
          if (!isLocalPreview && again && Date.now() - lastPresence > 15000) {
            lastPresence = Date.now();
            void api.presence(stored).catch(() => { /* Presence is advisory; the game state remains authoritative. */ });
          }
        }
      }
      catch (e) { if (!cancelled) setPollError((e as Error).message); }
      if (!cancelled && again) timer = setTimeout(poll, document.hidden ? 15000 : 3000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [roomId, accept]);

  function lock() { if (busyRef.current) return false; busyRef.current = true; setBusy(true); setError(''); return true; }
  function unlock() { busyRef.current = false; setBusy(false); }
  async function begin(story: StorySummary) {
    if (!lock()) return;
    const key = `${story.id}:${mode}`;
    if (createAttempt.current?.key !== key) createAttempt.current = getAttempt(key);
    const attempt = createAttempt.current;
    try {
      const { view: created } = await api.create(story.id, mode, attempt.token, attempt.id);
      const next = { roomId: created.id, token: attempt.token, mode };
      saveSession(next); setResume(next); setSession(next); accept(created); setSelected(null);
      clearAttempt(key); createAttempt.current = null; navigate(`room/${created.id}`);
    } catch (e) { setError((e as Error).message); }
    finally { unlock(); }
  }
  async function join(id: string) {
    if (!/^[a-zA-Z0-9_-]{6,32}$/.test(id)) { setError('请粘贴完整邀请链接，或填写房间码。'); return; }
    const existing = loadSession(id);
    if (existing) { setJoinDialog(false); navigate(`room/${id}`); return; }
    if (!lock()) return;
    const key = `join:${id}`;
    if (createAttempt.current?.key !== key) createAttempt.current = getAttempt(key);
    const attempt = createAttempt.current;
    try {
      const { view: joined } = await api.join(id, attempt.token, attempt.id);
      const next: Session = { roomId: joined.id, token: attempt.token, mode: 'duo' };
      saveSession(next); setResume(next); setSession(next); accept(joined); setJoinDialog(false);
      clearAttempt(key); createAttempt.current = null; navigate(`room/${joined.id}`);
    } catch (e) { setError((e as Error).message); }
    finally { unlock(); }
  }
  function joinFromInput() {
    const raw = joinInput.trim();
    const match = raw.match(/#(?:join|room)\/([a-zA-Z0-9_-]+)/);
    void join(match?.[1] || raw);
  }
  const sendPending = async () => {
    const pending = pendingCommand.current;
    if (!pending || !lock()) return;
    try {
      const { view: next } = await api.command(pending.session, pending.revision, pending.id, pending.command);
      clearPending(pending.session.roomId);
      if (getRoute() === `room/${pending.session.roomId}`) { accept(next); pendingCommand.current = null; setUncertain(false); }
      if (pending.command.action === 'leave') { forgetActive(); setResume(null); if (getRoute() === `room/${pending.session.roomId}`) navigate('library'); }
    } catch (e) {
      if (getRoute() === `room/${pending.session.roomId}`) setError((e as Error).message);
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        clearPending(pending.session.roomId);
        if (getRoute() === `room/${pending.session.roomId}`) {
          pendingCommand.current = null; setUncertain(false);
          try { const result = await api.read(pending.session); if (getRoute() === `room/${pending.session.roomId}`) accept(result.view); } catch { /* keep original error */ }
        }
      } else if (getRoute() === `room/${pending.session.roomId}`) setUncertain(true);
    } finally { unlock(); }
  };
  const command = (cmd: Command) => {
    if (!session || !view || busyRef.current || uncertain) return;
    pendingCommand.current = { session, revision: view.revision, id: requestId(), command: cmd };
    storePending(pendingCommand.current);
    void sendPending();
  };
  const isGame = Boolean(roomId);
  const featured = stories.find(s => s.id === 'friends-meal') || stories[0];
  const completedIds = new Set(echoes.map(e => e.storyId));
  const onOpen = (s: StorySummary) => { storyTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setError(''); createAttempt.current = null; setSelected(s); };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setToast('已复制，可以发给对方了'); } catch { setToast('浏览器暂不允许自动复制，请手动选中链接复制'); } };

  return <div className="site-shell">
    <a href="#main-content" className="skip-link" onClick={e => { e.preventDefault(); mainRef.current?.focus(); }}>跳到主要内容</a>
    <header className="site-header"><div className="header-inner">
      <button className="brand" onClick={() => navigate('library')} aria-label="同频不同词，返回故事馆"><Mark/><span>同频不同词<small>SAME WAVELENGTH</small></span></button>
      <nav aria-label="主导航"><button className={!isGame && route !== 'collection' ? 'active' : ''} onClick={() => navigate('library')}><BookOpen size={16}/>故事馆</button><button className={route === 'collection' ? 'active' : ''} onClick={() => navigate('collection')}><Headphones size={16}/>我的回声{echoes.length > 0 && <span className="nav-count">{echoes.length}</span>}</button></nav>
      <div className="header-end"><span className="beta-label"><span/>{isLocalPreview ? '本地测试版' : '公开体验版'}</span><button className="help-link" onClick={() => setHelp(true)}><CircleHelp size={17}/><span>怎么玩</span></button></div>
    </div></header>
    <main id="main-content" ref={mainRef} tabIndex={-1} className={isGame ? 'game-main' : 'library-main'}>
      {isGame ? <>
        {(error || pollError || uncertain) && <div className="error-banner" role="alert"><span>{error || pollError || '上次操作的结果尚未确认。请重试同一次操作，进度不会被重复提交。'}</span>{uncertain && <Secondary disabled={busy} onClick={() => void sendPending()}>重试上次操作</Secondary>}</div>}
        {view && view.id === roomId ? <Game key={view.id} view={view} busy={busy || uncertain} command={command} back={() => navigate('library')} copy={copy}/> : <div className="loading-panel"><LoaderCircle className="spin"/><h1>正在找回这一页故事</h1><p>你的角色和进度会在刷新后保留。</p><Secondary onClick={() => navigate('library')}>返回故事馆</Secondary></div>}
      </> : joinId ? <section className="invitation-panel"><span className="big-icon"><Users size={34}/></span><Kicker>AN INVITATION FOR TWO</Kicker><h1>另一边的座位，<br/>留给了你。</h1><p>朋友邀请你进入同一个故事。<br/>你们会拿到不同的背景，最后交换彼此的世界。</p><div className="room-code">房间 {joinId}</div>{error && <p className="error-text" role="alert">{error}</p>}<Primary loading={busy} onClick={() => void join(joinId)}>坐到另一边<ArrowRight size={18}/></Primary><button className="text-button" onClick={() => navigate('library')}>先逛逛故事馆</button><small>无需注册 · 房间 24 小时有效 · {isLocalPreview ? '本地邀请仅限当前电脑测试' : '手机和电脑均可入座'}</small></section>
      : route === 'collection' ? <>
        <div className="collection-heading"><Kicker>THE WORDS THAT STAY</Kicker><h1>故事结束了，<br/>有些话留了下来。</h1><p>这里收着你走过的故事。仅保存在当前浏览器，不是对关系的评判。</p></div>
        {echoes.length ? <div className="echo-grid">{echoes.map(e => <article key={e.id} className={`echo-card tone-${relations[e.relation as Relation]?.color || 'sage'}`}><span className="echo-date">{new Date(e.date).toLocaleDateString('zh-CN')} · {e.mode === 'solo' ? '一个人换位' : '两个人同频'}</span><span className="quote-mark">“</span><h2>{e.title}</h2><blockquote>{e.quote}</blockquote><p>{e.takeaway}</p><button className="text-button" onClick={() => { const s = stories.find(s => s.id === e.storyId); if (s) onOpen(s); }}>再走一次这个故事<ArrowUpRightLocal/></button></article>)}</div> : <div className="empty-state"><Headphones size={40}/><h2>还没有留下回声</h2><p>完成一篇故事，把值得再想一想的话留在这里。</p><Primary onClick={() => navigate('library')}>去选一个故事<ArrowRight size={16}/></Primary></div>}
      </> : <>
        <section className="opening-spread" aria-label="生活小剧场开篇">
          <div className="opening-copy"><div className="issue-line"><span>日常关系小剧场</span><span>VOL. 01 / 12 STORIES</span></div><h1>同一件小事，<br/><em>另一种</em>意思。</h1><div className="opening-description"><span className="short-rule"/><p>你说的，和我听到的。<br/>有时，只隔着一个还没问出口的问题。</p></div>
            <div className="seat-selector" aria-label="选择体验方式"><button className={mode === 'solo' ? 'selected' : ''} aria-pressed={mode === 'solo'} onClick={() => setMode('solo')}><Headphones size={17}/><span>一个人，换个座位<small>独自也能完整体验</small></span></button><button className={mode === 'duo' ? 'selected' : ''} aria-pressed={mode === 'duo'} onClick={() => setMode('duo')}><Users size={17}/><span>两个人，交换世界<small>邀请朋友共同入座</small></span></button></div>
            <div className="opening-actions"><Primary disabled={!featured} onClick={() => featured && onOpen(featured)}>{mode === 'solo' ? '坐到故事里' : '邀请朋友入座'}<ArrowRight size={18}/></Primary><span><Clock3 size={13}/>一篇，约 3–5 分钟</span></div><button className="join-link" onClick={() => { setJoinDialog(true); setError(''); }}>收到邀请？加入房间<ArrowRight size={14}/></button>
          </div>
          <div className="opening-art"><div className="art-folio"><span>第一幕 / 朋友 · 晚饭之前</span><span>01</span></div><StoryArt relation="friends" featured/><div className="perspective-slip"><span>A SIDE</span><p>“都行，你选。”</p><small>我想把选择交给你。</small></div><div className="perspective-caption"><span>B SIDE</span><p>你听到的，也是这个意思吗？</p><ArrowLeftRight size={26}/></div></div>
        </section>
        {resume && <div className="resume-banner"><span><BookOpen size={17}/>你还有一页没合上的故事</span><button onClick={() => navigate(`room/${resume.roomId}`)}>继续上次体验<ArrowRight size={15}/></button></div>}
        {loading ? <div className="loading-panel compact"><LoaderCircle className="spin"/><p>正在打开故事馆…</p></div> : catalogError ? <div className="empty-state"><CircleHelp size={30}/><h2>故事馆暂时没有连接上</h2><p role="alert">{catalogError}</p><Secondary onClick={() => void loadCatalog()}>重新连接</Secondary></div> : <>
          <StoryLibrary stories={stories} completedIds={completedIds} onOpen={onOpen} navigation={libraryNavigation}/>
          <div className="library-bottom"><p><span>不急着给关系打分。</span>先听完，对方的另一半故事。</p><button className="text-button" onClick={() => stories.length && onOpen(stories[Math.floor(Math.random() * stories.length)])}><Shuffle size={16}/>让缘分选一篇<ArrowRight size={15}/></button></div>
        </>}
      </>}
    </main>
    <footer className="site-footer"><span><Mark/>同频不同词<span className="footer-divider">/</span>每句话，都有另一边。</span><span>虚构情境 · 不做人格或关系测评<span className="footer-divider">·</span>Made with Qoder</span></footer>
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open && !busy) { setSelected(null); setError(''); } }}><DialogContent className="story-dialog" onCloseAutoFocus={event => { event.preventDefault(); if (storyTrigger.current?.isConnected) storyTrigger.current.focus({ preventScroll: true }); else mainRef.current?.focus({ preventScroll: true }); }}><DialogHeader><DialogTitle>{selected?.title}</DialogTitle><DialogDescription>{selected ? `${relations[selected.relation].label} · ${topics[selected.topic].label} · ${selected.duration}` : ''}</DialogDescription></DialogHeader>{selected && <><div className="dialog-scene"><span><BookOpen size={16}/>{selected.location}</span><p>{selected.setup}</p></div><div className="dialog-objective"><small>这一次，一起完成的小事</small><p>{selected.objective}</p></div><div className="cast-row">{(['A', 'B'] as const).map(role => <div key={role}><span className={`mini-role role-${role}`}>{role}</span><b>{selected.cast[role].name}</b><small>{selected.cast[role].identity}</small></div>)}</div><p className="dialog-note">{mode === 'solo' ? '你先扮演角色 A。另一位角色按故事分支回应，不使用实时 AI。故事结束后，再坐到另一边。' : '你会扮演角色 A，朋友扮演角色 B。各自的本意在揭晓前保密；点击“问清楚”会得到对方预先确认的解释。'}</p>{error && <p className="error-text" role="alert">{error}</p>}<Primary loading={busy} onClick={() => void begin(selected)}>{mode === 'solo' ? '翻开我的这一面' : '创建双人房间'}<ArrowRight size={17}/></Primary></>}</DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent className="help-dialog"><DialogHeader><DialogTitle>不是猜对，是看见。</DialogTitle><DialogDescription>同一句话，可能在两个人心里走向不同的地方。</DialogDescription></DialogHeader><ol className="how-steps"><li><span>01</span><div><b>带着自己的处境入座</b><p>先读你的角色背景，对方的另一面暂时保密。</p></div></li><li><span>02</span><div><b>分开记录本意与表达</b><p>选择心里想的、嘴上说的；收到消息时，记录你的理解。也可以先问清楚。</p></div></li><li><span>03</span><div><b>交换视角，回到那一句</b><p>三轮之后揭晓双轨回放。改一句表达，再试试看。没有情商分数，也没有唯一正确关系。</p></div></li></ol><div className="privacy-note"><Leaf size={18}/><p>不调用模型、不采集真实聊天。单人对方为预设角色。房间在{isLocalPreview ? '本机' : '云端'}保存，24 小时后失效；刷新可恢复，但关闭标签页可能丢失临时身份。回声只保存在本浏览器。公开版每日有新房间额度保护；额度用完会提示稍后再来。</p></div></DialogContent></Dialog>
    <Dialog open={joinDialog} onOpenChange={open => { if (!busy) { setJoinDialog(open); setError(''); } }}><DialogContent><DialogHeader><DialogTitle>来，坐到另一边。</DialogTitle><DialogDescription>粘贴朋友的邀请链接，或填写房间码。{isLocalPreview ? '当前为本地测试环境。' : '不需要注册账号，直接入座。'}</DialogDescription></DialogHeader><label className="field-label" htmlFor="join-code">邀请链接或房间码</label><input id="join-code" className="text-input" value={joinInput} onChange={e => setJoinInput(e.target.value)} placeholder="粘贴到这里" onKeyDown={e => { if (e.key === 'Enter') joinFromInput(); }}/>{error && <p className="error-text" role="alert">{error}</p>}<Primary loading={busy} disabled={!joinInput.trim()} onClick={joinFromInput}>加入房间<ArrowRight size={17}/></Primary></DialogContent></Dialog>
    {toast && <div className="toast" role="status"><Check size={17}/>{toast}</div>}
  </div>;
}
function ArrowUpRightLocal() { return <ChevronRight size={16}/>; }
