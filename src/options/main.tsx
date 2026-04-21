import { createRoot } from 'react-dom/client';
import Options from './Options';
import './options.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<Options />);
}
