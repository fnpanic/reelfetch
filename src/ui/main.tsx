import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const sidebar = document.body.dataset.sidebar === '1';
document.documentElement.lang = chrome.i18n.getUILanguage();
createRoot(document.getElementById('root')!).render(<App sidebar={sidebar} />);
