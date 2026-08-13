import { NavLink, Route, Routes } from 'react-router';
import { Browse } from './routes/Browse.tsx';
import { Picks } from './routes/Picks.tsx';
import { Downloads } from './routes/Downloads.tsx';
import { Failed } from './routes/Failed.tsx';
import { Settings } from './routes/Settings.tsx';

export function App() {
  return (
    <div className="app">
      <nav>
        <NavLink to="/">Browse</NavLink>
        <NavLink to="/picks">Picks</NavLink>
        <NavLink to="/downloads">Downloads</NavLink>
        <NavLink to="/failed">Failed</NavLink>
        {/*
          Settings is not a view of the library, it is a view of the
          installation, and the em dash is what says so. `aria-hidden` because
          it is punctuation: without it a screen reader announces "em dash" as a
          nav item, which is noise for the one class of user who cannot see the
          visual grouping it exists to convey.
        */}
        <span className="nav-separator" aria-hidden="true">—</span>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/picks" element={<Picks />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/failed" element={<Failed />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
