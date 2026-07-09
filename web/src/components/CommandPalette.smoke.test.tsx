import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from './CommandPalette';

const apiMock = vi.hoisted(() => ({
  workspaces: vi.fn(),
  workspace: vi.fn(),
  settings: vi.fn(),
  setYoloMode: vi.fn(),
  search: vi.fn(),
  searchMessages: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: apiMock,
  basename: (value: string) => value.split('/').filter(Boolean).at(-1) || value,
  fmtAgo: () => 'just now',
}));

vi.mock('../lib/canvas', () => ({
  addDraftSid: vi.fn(),
}));

describe('CommandPalette smoke', () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    apiMock.workspaces.mockResolvedValue({
      workspaces: [
        {
          project: 'project-a',
          name: 'Alpha',
          cwd: '/work/alpha',
          mtime: 2_000,
          sessionCount: 1,
        },
      ],
    });
    apiMock.workspace.mockResolvedValue({
      project: 'project-a',
      cwd: '/work/alpha',
      sessions: [
        {
          project: 'project-a',
          sessionId: 'session-1',
          preview: 'Fix flaky tests',
          mtime: 2_000,
        },
      ],
    });
    apiMock.settings.mockResolvedValue({ yoloMode: false });
    apiMock.setYoloMode.mockResolvedValue({ yoloMode: true });
    apiMock.search.mockResolvedValue({ enabled: false, hits: [] });
    apiMock.searchMessages.mockResolvedValue({
      hits: [
        {
          project: 'project-b',
          sessionId: 'session-2',
          uuid: 'message-1',
          role: 'assistant',
          snippet: 'Found the needle in a transcript',
          preview: 'Deployment chat',
          mtime: 1_000,
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens, loads every source, searches messages, and supports keyboard navigation', async () => {
    const focusEvents: Array<{ project: string; sid: string }> = [];
    const onFocus = (event: Event) => {
      focusEvents.push((event as CustomEvent<{ project: string; sid: string }>).detail);
    };
    window.addEventListener('macaron:focus-tile', onFocus);

    render(
      <MemoryRouter initialEntries={['/w/project-a']}>
        <CommandPalette />
      </MemoryRouter>,
    );

    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    const input = screen.getByPlaceholderText('Search sessions, workspaces, messages, or run an action…');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Actions')).toBeTruthy();
    expect(await screen.findByText('Fix flaky tests')).toBeTruthy();
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getByText('Workspaces')).toBeTruthy();
    expect(document.activeElement).toBe(input);

    for (let i = 0; i < 4; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(focusEvents).toEqual([{ project: 'project-a', sid: 'session-1' }]);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const searchInput = screen.getByPlaceholderText('Search sessions, workspaces, messages, or run an action…');
    fireEvent.change(searchInput, { target: { value: 'needle' } });

    expect(await screen.findByText('Found the needle in a transcript')).toBeTruthy();
    expect(screen.getByText('Messages')).toBeTruthy();
    expect(apiMock.search).toHaveBeenCalledWith('needle', 20);
    expect(apiMock.searchMessages).toHaveBeenCalledWith('needle', 20);

    fireEvent.keyDown(searchInput, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(focusEvents).toEqual([
      { project: 'project-a', sid: 'session-1' },
      { project: 'project-b', sid: 'session-2' },
    ]);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const escapeInput = screen.getByPlaceholderText('Search sessions, workspaces, messages, or run an action…');
    fireEvent.keyDown(escapeInput, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    window.removeEventListener('macaron:focus-tile', onFocus);
  });
});
