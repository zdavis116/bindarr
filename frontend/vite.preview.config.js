// Render the REAL DeckCompareModal against REAL Mana Pool data.
//
// Not a hand-built HTML mock: a mock drifts from the component and then I am
// reviewing my own drawing instead of the screen Zach will open. This imports
// the actual JSX, feeds it a payload shaped exactly like the route's response,
// and writes a page the screenshot tool can load.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve('preview'),
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
});
