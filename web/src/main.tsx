import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './chat.css';
import './shell.css';
import './hire.css';
import './playbook.css';
import './connectors.css';

// Inside the desktop shell, the topbar doubles as the window title bar, so it
// needs padding and drag regions — and WHICH edge to pad depends on the OS:
// traffic lights on the left of a Mac window, caption buttons on the right of
// a Windows one. The preload bridge says which.
if (navigator.userAgent.includes('Electron')) {
  document.body.classList.add('electron', `platform-${window.airoomNative?.platform ?? 'unknown'}`);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
