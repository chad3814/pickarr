import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.tsx';
import './styles/index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element in the document');

// The router wraps App, rather than App defining routes itself: a deep link
// must survive signing in, and it does because BrowserRouter's history is an
// ancestor of the phase switch (`App.tsx`'s own doc), not inside either
// branch of it. App's job stays "SignIn when unauthenticated, Shell when
// not"; the routes themselves -- one per registered plugin, plus
// /unmatched and /settings -- live in `shell/Shell.tsx`, which is the only
// branch that ever needs them, and derive from `plugins/registry.ts`.
createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
