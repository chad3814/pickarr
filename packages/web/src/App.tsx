import { NavLink, Route, Routes } from 'react-router';
import { Browse } from './routes/Browse.tsx';
import { Picks } from './routes/Picks.tsx';
import { Downloads } from './routes/Downloads.tsx';
import { Failed } from './routes/Failed.tsx';
import { Settings } from './routes/Settings.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';

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
          installation, and this rule is what says so.

          An `<hr>` rather than the em dash it replaces, and not only because a
          dash between two stacked links reads as a stray character once the nav
          is a column. The dash carried `aria-hidden="true"` because a screen
          reader announcing "em dash" is noise — which meant the grouping was
          conveyed to sighted readers and to nobody else. An `<hr>` is a thematic
          break with an implicit `role="separator"`, so it announces the division
          itself. That is the whole reason there is no `aria-hidden` here: hiding
          it would throw away the one thing this element can express that the
          dash could not.
        */}
        <hr className="nav-separator" />
        <NavLink to="/settings">Settings</NavLink>
        {/*
          Below the rule that separates the library from the installation,
          because it is neither: it is a per-browser preference, and the foot of
          the chrome is where a reader looks for one.
        */}
        <ThemeToggle />
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
