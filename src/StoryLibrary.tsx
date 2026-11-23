import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Clock3 } from 'lucide-react';
import type { Relation, StorySummary, Topic } from '../shared/types';
import { relations, StoryArt, topics } from './ui';
import './homepage.css';

export type LibraryNavigation = { category: Relation | null; hubScroll: number; sceneScroll: number; visited: boolean; focusedStory?: string };
type Phase = 'hub' | 'entering' | 'scenes' | 'leaving';
const relationKeys = Object.keys(relations) as Relation[];
const topicKeys = Object.keys(topics) as Topic[];
const crops: Record<Relation, Record<Topic, string>> = {
  friends: { meal: '46% 68%', travel: '12% 30%', message: '66% 36%', help: '90% 50%' },
  family: { meal: '50% 74%', travel: '16% 46%', message: '30% 30%', help: '74% 32%' },
  couple: { meal: '84% 56%', travel: '50% 60%', message: '46% 28%', help: '16% 62%' },
};

export default function StoryLibrary({ stories, completedIds, onOpen, navigation }: {
  stories: StorySummary[]; completedIds: Set<string>; onOpen: (story: StorySummary) => void;
  navigation: MutableRefObject<LibraryNavigation>;
}) {
  const [category, setCategory] = useState<Relation | null>(navigation.current.category);
  const [phase, setPhase] = useState<Phase>(category ? 'scenes' : 'hub');
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const phaseRef = useRef(phase);
  const categoryRef = useRef(category);
  const sectionRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const cardsRef = useRef<Partial<Record<Relation, HTMLButtonElement | null>>>({});
  const returnCategory = useRef(category);
  const restoreFocus = useRef(false);
  const touch = useRef<{ x: number; y: number; time: number; horizontal: boolean } | null>(null);
  const transitioning = phase === 'entering' || phase === 'leaving';
  phaseRef.current = phase;
  categoryRef.current = category;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useLayoutEffect(() => {
    if (!navigation.current.visited) { navigation.current.visited = true; return; }
    const frame = requestAnimationFrame(() => {
      const saved = navigation.current;
      window.scrollTo({ top: saved.category ? saved.sceneScroll : saved.hubScroll, behavior: 'instant' });
      if (saved.category) {
        const card = saved.focusedStory ? sectionRef.current?.querySelector<HTMLButtonElement>(`[data-story-id="${CSS.escape(saved.focusedStory)}"]`) : null;
        (card ?? backRef.current)?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [navigation]);

  const finish = useCallback(() => {
    if (phaseRef.current === 'entering') {
      phaseRef.current = 'scenes'; setPhase('scenes');
      requestAnimationFrame(() => {
        const top = Math.max(0, (sectionRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 24);
        window.scrollTo({ top, behavior: 'instant' });
        navigation.current.sceneScroll = window.scrollY;
        backRef.current?.focus({ preventScroll: true });
      });
    } else if (phaseRef.current === 'leaving') {
      phaseRef.current = 'hub'; categoryRef.current = null;
      navigation.current.category = null;
      setPhase('hub'); setCategory(null); restoreFocus.current = true;
    }
  }, [navigation]);

  useEffect(() => {
    if (!transitioning) return;
    // Fallback also completes when the page is hidden or a user changes motion preferences.
    const timer = setTimeout(finish, reduced ? 120 : phase === 'entering' ? 280 : 240);
    return () => clearTimeout(timer);
  }, [phase, reduced, transitioning, finish]);

  useLayoutEffect(() => {
    if (phase !== 'hub' || !restoreFocus.current) return;
    restoreFocus.current = false;
    window.scrollTo({ top: navigation.current.hubScroll, behavior: 'instant' });
    const key = returnCategory.current;
    if (key) cardsRef.current[key]?.focus({ preventScroll: true });
  }, [phase, navigation]);

  const enter = (key: Relation) => {
    if (phaseRef.current !== 'hub') return;
    navigation.current.hubScroll = window.scrollY;
    navigation.current.category = key;
    navigation.current.focusedStory = undefined;
    returnCategory.current = key;
    phaseRef.current = 'entering'; categoryRef.current = key;
    setCategory(key); setPhase('entering');
  };
  const back = useCallback(() => {
    if (phaseRef.current !== 'scenes') return;
    navigation.current.sceneScroll = window.scrollY;
    returnCategory.current = categoryRef.current;
    phaseRef.current = 'leaving'; setPhase('leaving');
  }, [navigation]);

  useEffect(() => {
    const modalOpen = () => Boolean(document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]'));
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || modalOpen() || phaseRef.current !== 'scenes') return;
      event.preventDefault(); back();
    };
    const start = (event: TouchEvent) => {
      if (phaseRef.current !== 'scenes' || window.innerWidth > 760 || modalOpen() || event.touches.length !== 1) return;
      const point = event.touches[0];
      touch.current = point.clientX <= 24 ? { x: point.clientX, y: point.clientY, time: performance.now(), horizontal: false } : null;
    };
    const move = (event: TouchEvent) => {
      const origin = touch.current;
      if (!origin || event.touches.length !== 1) return;
      const dx = event.touches[0].clientX - origin.x, dy = event.touches[0].clientY - origin.y;
      if (!origin.horizontal && Math.abs(dy) > 12 && Math.abs(dy) > dx) { touch.current = null; return; }
      if (dx > 12 && dx > Math.abs(dy) * 1.5) origin.horizontal = true;
      if (origin.horizontal && event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const origin = touch.current; touch.current = null;
      if (!origin || !event.changedTouches.length || modalOpen()) return;
      const point = event.changedTouches[0];
      if (point.clientX - origin.x >= 72 && Math.abs(point.clientY - origin.y) <= 64 && performance.now() - origin.time <= 700) back();
    };
    const cancel = () => { touch.current = null; };
    window.addEventListener('keydown', keydown, { capture: true });
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end, { passive: true });
    window.addEventListener('touchcancel', cancel);
    return () => {
      window.removeEventListener('keydown', keydown, { capture: true }); window.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move); window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', cancel);
    };
  }, [back]);

  return <section ref={sectionRef} className="story-library library-navigation" aria-label="所有故事" data-phase={phase} data-reduced={reduced}>
    <div className="library-stage">
      <div className="hub-panel" hidden={phase === 'scenes'} inert={phase !== 'hub'} aria-hidden={phase !== 'hub'}>
        <div className="section-heading"><h2>找一件熟悉的小事<span>THE STORY LIBRARY</span></h2></div>
        <div className="relation-grid" aria-label="选择关系分类">
          {relationKeys.map((key, index) => {
            const item = relations[key], Icon = item.icon;
            return <button key={key} ref={element => { cardsRef.current[key] = element; }} type="button"
              className={`relation-card tone-${item.color} ${category === key && phase === 'entering' ? 'is-pressing' : ''}`}
              onClick={() => enter(key)} aria-label={`${item.label}，${stories.filter(story => story.relation === key).length} 个场景`}>
              <StoryArt relation={key} featured/>
              <div className="relation-copy"><div className="relation-meta"><span>0{index + 1}</span><span>{stories.filter(story => story.relation === key).length} 段日常 / 两种视角</span></div>
                <h3><Icon size={24}/>{item.label}<ArrowUpRight size={24}/></h3><p>{item.subtitle}</p>
              </div>
            </button>;
          })}
        </div>
      </div>
      {category && <div className={`scene-panel tone-${relations[category].color}`} hidden={phase === 'hub'} inert={phase !== 'scenes'} aria-hidden={phase !== 'scenes'}
        onAnimationEnd={event => { if (event.target === event.currentTarget) finish(); }}>
        <div className="scene-heading"><button ref={backRef} className="category-back" type="button" onClick={back}><ArrowLeft size={18}/>返回</button>
          <div className="scene-title"><h2>{relations[category].label}</h2><p>{relations[category].subtitle}</p></div>
        </div>
        <div className="scene-grid" aria-label={`${relations[category].label}的场景`}>
          {topicKeys.map(topic => {
            const story = stories.find(story => story.relation === category && story.topic === topic);
            if (!story) return null;
            const completed = completedIds.has(story.id);
            return <button key={story.id} type="button" className={`story-card scene-card tone-${relations[category].color}`}
              style={{ '--art-focus': crops[category][topic] } as CSSProperties} data-story-id={story.id}
              aria-label={`${topics[topic].label}，${story.title}，${completed ? '已体验' : story.duration}`} onClick={() => { navigation.current.focusedStory = story.id; onOpen(story); }}>
              <StoryArt relation={category} topic={topic}/>
              <div className="card-copy"><div className="card-meta"><span>STORY {story.number}</span><span><Clock3 size={12}/>{story.duration}</span></div>
                <h3>{story.title}<ArrowUpRight size={20}/></h3><p>{story.subtitle}</p>
                <div className="card-bottom"><span>{story.mood}</span><span>{completed ? <><Check size={12}/>已体验</> : topics[topic].label}</span></div>
              </div>
            </button>;
          })}
        </div>
      </div>}
    </div>
  </section>;
}
