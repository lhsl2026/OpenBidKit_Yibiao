import { useCallback, useEffect, useRef, useState } from 'react';
import AppRouter from './app/AppRouter';
import GpuHardwareAccelerationPrompt from './app/GpuHardwareAccelerationPrompt';
import RequiredOnlineServicesPrompt from './app/RequiredOnlineServicesPrompt';
import { deepLinkFeedback, type NavigationResult } from './app/deepLinkFeedback';
import AppShell from './components/AppShell';
import { trackAppOpen, trackConfigUsage, trackPageView } from './shared/analytics/analytics';
import type { SectionId } from './shared/types/navigation';
import { useToast } from './shared/ui';

function isDeveloperSection(section: SectionId) {
  return section.startsWith('developer-');
}

function isManagedWorkbenchSection(section: SectionId) {
  return section === 'technical-plan' || section === 'existing-plan-expansion' || section === 'feasibility-report';
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('bid-generation');
  const [developerMode, setDeveloperMode] = useState(false);
  const leaveGuardRef = useRef<((nextSection?: string) => Promise<boolean>) | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    trackAppOpen();

    void window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config?.developer_mode));
        trackConfigUsage({}, config);
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    trackPageView(activeSection);
    if (isManagedWorkbenchSection(activeSection)) return;
    void window.yibiao?.ui?.setCurrentView({ section: activeSection });
  }, [activeSection]);

  useEffect(() => {
    if (!developerMode && isDeveloperSection(activeSection)) {
      setActiveSection('bid-generation');
    }
  }, [activeSection, developerMode]);

  const requestSectionChange = useCallback(async (section: SectionId): Promise<NavigationResult> => {
    if (section === activeSection) {
      return 'unchanged';
    }
    const allowed = await (leaveGuardRef.current?.(section) ?? Promise.resolve(true));
    if (allowed) {
      setActiveSection(section);
      return 'changed';
    }
    return 'blocked';
  }, [activeSection]);

  useEffect(() => window.yibiao?.ui?.onDeepLink((intent) => {
    if (intent.action === 'new-bid') {
      void requestSectionChange(intent.section).then((result) => {
        const feedback = deepLinkFeedback(result, intent.section);
        showToast(feedback.message, feedback.type);
      });
    }
  }), [requestSectionChange, showToast]);

  return (
    <>
      <GpuHardwareAccelerationPrompt />
      <RequiredOnlineServicesPrompt />
      <AppShell
        activeSection={activeSection}
        developerMode={developerMode}
        onSectionChange={(section) => { void requestSectionChange(section); }}
      >
        <AppRouter
          activeSection={activeSection}
          developerMode={developerMode}
          onDeveloperModeChange={setDeveloperMode}
          onSectionChange={(section) => { void requestSectionChange(section); }}
          registerLeaveGuard={(guard) => {
            leaveGuardRef.current = guard;
          }}
        />
      </AppShell>
    </>
  );
}

export default App;
