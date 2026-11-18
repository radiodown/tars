import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.jsx';
import './styles.css';
import './theme.css';
import './ceo.css';
import './organization.css';
import './model-fields.css';
import './session-console.css';
import './menu-order.css';
import './floating-usage.css';
import './mobile.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 3000 } } });
createRoot(document.getElementById('root')).render(
  <React.StrictMode><QueryClientProvider client={client}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></React.StrictMode>,
);
