import { readFile, writeFile } from 'node:fs/promises';
import { validateStories } from '../functions/engine.mjs';
const source = JSON.parse(await readFile(new URL('../content/stories.json', import.meta.url), 'utf8'));
validateStories(source);
// Server-only bundle; never copied into the public/dist directory.
await writeFile(new URL('../functions/story-data.mjs', import.meta.url), `// Generated from content/stories.json; run npm run build to refresh.\nexport default ${JSON.stringify(source)};\n`, 'utf8');
console.log(`Bundled ${source.length} stories for the Function runtime.`);
