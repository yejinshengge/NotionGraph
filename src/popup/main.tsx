import { createRoot } from 'react-dom/client';
import Popup from './Popup';
import './popup.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<Popup />);
}
