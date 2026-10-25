// Base styles first so module stylesheets (imported via the shell) can refine them.
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient, connectLiveUpdates } from './lib/query';
import { Shell } from './app/Shell';
import { Toasts } from './ui/toast';

// The Electron shell injects the macOS accent color and marks the document for vibrancy.
const w = window as any;
if (w.margin?.accent) document.documentElement.style.setProperty('--accent', w.margin.accent);
if (w.margin) document.documentElement.classList.add('electron');

connectLiveUpdates();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Shell />
      <Toasts />
    </QueryClientProvider>
  </StrictMode>,
);
