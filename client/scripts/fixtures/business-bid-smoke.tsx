import React from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '../../src/shared/ui/ToastProvider';
import BusinessBidPage from '../../src/features/business-bid/pages/BusinessBidPage';
import '../../src/styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><ToastProvider><BusinessBidPage /></ToastProvider></React.StrictMode>);
