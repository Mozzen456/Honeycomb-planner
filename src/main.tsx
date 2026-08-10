import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './ui/base.css';
import { App } from './ui/App';

const host = document.getElementById('root');
if (!host) throw new Error('#root missing from index.html');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
