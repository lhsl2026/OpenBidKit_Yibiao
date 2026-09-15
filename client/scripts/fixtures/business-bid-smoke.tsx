import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '../../src/shared/ui/ToastProvider';
import AppRouter from '../../src/app/AppRouter';
import type { SectionId } from '../../src/shared/types/navigation';
import '../../src/styles.css';
function BusinessBidSmoke() {
  const [section, setSection] = useState<SectionId>('bid-generation');
  return <AppRouter activeSection={section} developerMode={false} onDeveloperModeChange={() => {}} onSectionChange={setSection} />;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ToastProvider><BusinessBidSmoke /></ToastProvider></React.StrictMode>);
