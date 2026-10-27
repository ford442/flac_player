import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { createQueryClient } from './api/library';
import { registerServiceWorker } from './sw/serviceWorkerClient';
import { initTrackCacheServiceWorkerBridge } from './storage/trackCache';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

const queryClient = createQueryClient();

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

initTrackCacheServiceWorkerBridge();
void registerServiceWorker();
