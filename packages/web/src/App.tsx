import { NavLink, Route, Routes } from 'react-router';
import { Browse } from './routes/Browse.tsx';
import { Picks } from './routes/Picks.tsx';
import { Downloads } from './routes/Downloads.tsx';

export function App() {
  return (
    <div className="app">
      <nav>
        <NavLink to="/">Browse</NavLink>
        <NavLink to="/picks">Picks</NavLink>
        <NavLink to="/downloads">Downloads</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/picks" element={<Picks />} />
          <Route path="/downloads" element={<Downloads />} />
        </Routes>
      </main>
    </div>
  );
}
