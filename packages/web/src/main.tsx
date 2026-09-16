import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element in the document');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
