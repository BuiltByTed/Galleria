import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SetupWizard from './SetupWizard';
import translations from '../../i18n/locales/en.json';

vi.mock('../../config', () => ({ API_URL: '' }));
vi.mock('../RestartModal', () => ({ default: () => null }));
vi.mock('../AdminPortal/ConfigManager/components/CustomDropdown', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    ready: true,
    i18n: { language: 'en' },
    t: (key: string, fallback?: string) => key.split('.').reduce((value: any, part) => value?.[part], translations) || fallback || key,
  }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('asks for a local username by default and requires email only after Google opt-in', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ setupComplete: false, checks: {} }) }));
  const { container } = render(<SetupWizard />);
  fireEvent.change(await screen.findByLabelText(/Site Name/), { target: { value: 'Test Gallery' } });
  fireEvent.click(screen.getByRole('button', { name: /Next: Create Account/ }));
  const username = screen.getByLabelText(/Username/);
  expect(username.getAttribute('type')).toBe('text');
  expect(container.querySelector('input[type="email"]')).toBeNull();
  fireEvent.change(username, { target: { value: 'photographer' } });
  fireEvent.click(container.querySelector('input[value="google"]')!);
  expect(container.querySelector('#loginIdentifier')?.getAttribute('type')).toBe('email');
  expect(screen.getByText(`${window.location.origin}/api/auth/google/callback`)).toBeTruthy();
  fireEvent.click(container.querySelector('input[value="password"]')!);
  expect((screen.getByLabelText(/Username/) as HTMLInputElement).value).toBe('photographer');
  fireEvent.change(screen.getByLabelText(/Full Name/), { target: { value: 'Test Admin' } });
  fireEvent.change(container.querySelector('#adminPassword')!, { target: { value: 'test-password-123' } });
  fireEvent.change(container.querySelector('#adminPasswordConfirm')!, { target: { value: 'test-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: /Next: Customize/ }));
  expect(screen.getByRole('button', { name: /Complete Setup/ })).toBeTruthy();
});
