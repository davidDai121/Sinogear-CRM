import { createRoot } from 'react-dom/client';
import { Popup } from './Popup';
import '@/panel/styles.css';
import './popup.css';

createRoot(document.getElementById('root')!).render(<Popup />);
