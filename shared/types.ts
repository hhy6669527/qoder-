export type Role = 'A' | 'B';
export type Relation = 'friends' | 'family' | 'couple';
export type Topic = 'meal' | 'travel' | 'message' | 'help';
export type Mode = 'solo' | 'duo';
export interface Person { name: string; identity: string; background: string; goal: string }
export interface Intent { id: string; label: string; clarification: string }
export interface Line { id: string; text: string; style: 'hint' | 'direct' | 'question' }
export interface StoryRound {
  speaker: Role;
  title: string;
  prompt: string;
  leadIns: { normal: string; clarified: string; boundary: string };
  intents: Intent[];
  lines: Line[];
  replies: { accept: string; boundary: string };
  npc: { intent: string; line: string; guessByLine: Record<string, string> };
  insight: string;
}
export interface Story {
  id: string;
  number: string;
  relation: Relation;
  topic: Topic;
  title: string;
  subtitle: string;
  quote: string;
  location: string;
  mood: string;
  duration: string;
  setup: string;
  objective: string;
  roles: Record<Role, Person>;
  rounds: StoryRound[];
  endings: { clarified: string; boundary: string; open: string };
  takeaway: string;
}
export type StorySummary = Pick<Story, 'id' | 'number' | 'relation' | 'topic' | 'title' | 'subtitle' | 'quote' | 'location' | 'mood' | 'duration' | 'setup' | 'objective'> & { cast: Record<Role, Pick<Person, 'name' | 'identity'>> };
export interface RecordView {
  index: number;
  speaker: Role;
  title: string;
  text: string;
  reply?: string;
  asked: boolean;
  clarification?: string;
}
export interface RevealedRecord extends RecordView {
  intentId: string;
  intended: string;
  guessedId: string;
  interpreted: string;
  matched: boolean;
  response: 'accept' | 'boundary';
  insight: string;
  lineId: string;
}
export interface RoundView {
  index: number;
  speaker: Role;
  title: string;
  prompt: string;
  leadIn: string;
  intents?: { id: string; label: string }[];
  lines?: Line[];
  interpretations?: { id: string; label: string }[];
  incoming?: { text: string; clarification?: string };
  replies?: { accept: string; boundary: string };
}
export interface RepairView {
  index: number;
  speaker: Role;
  original: RevealedRecord;
  stage: 'compose' | 'interpret' | 'done';
  lines?: Line[];
  interpretations?: { id: string; label: string }[];
  text?: string;
  interpreted?: string;
  matched?: boolean;
}
export interface GameView {
  id: string;
  mode: Mode;
  revision: number;
  phase: 'waiting' | 'briefing' | 'playing' | 'reveal' | 'repair' | 'closed';
  role: Role;
  story: StorySummary;
  ownRole: Person;
  ready: Record<Role, boolean>;
  partnerOnline: boolean;
  partnerJoined: boolean;
  roundIndex: number;
  stage: 'compose' | 'interpret' | 'wait';
  round?: RoundView;
  records: RecordView[];
  reveal?: { roles: Record<Role, Person>; records: RevealedRecord[]; ending: string; takeaway: string };
  repair?: RepairView;
  expiresAt: number;
}
export interface Session { roomId: string; token: string; mode: Mode }
export type Command =
  | { action: 'ready' }
  | { action: 'compose'; intentId: string; lineId: string }
  | { action: 'clarify' }
  | { action: 'interpret'; guessId: string; response: 'accept' | 'boundary' }
  | { action: 'repair'; index: number }
  | { action: 'repair-compose'; lineId: string }
  | { action: 'repair-interpret'; guessId: string }
  | { action: 'repair-end' }
  | { action: 'leave' };
