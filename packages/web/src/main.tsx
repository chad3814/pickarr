import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element in the document');

// A placeholder entry, not the shell. `index.html` loads this module, so the
// file has to exist and compile for the build to produce a bundle at all --
// which is why deleting it alongside 1.x's `App.tsx` was not an option. Task 6
// replaces this file entirely with the real `App`, its router and its store
// wiring. Nothing here is a design decision; it is the smallest thing that
// builds.
createRoot(container).render(
  <StrictMode>
    <p>Pickarr is starting up.</p>
  </StrictMode>,
);
