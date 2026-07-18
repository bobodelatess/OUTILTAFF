// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurrentDay } from './useCurrentDay.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCurrentDay', () => {
  it('expose la date locale courante au format ISO', () => {
    vi.setSystemTime(new Date(2026, 6, 15, 10, 30));

    const { result } = renderHook(() => useCurrentDay());

    expect(result.current).toBe('2026-07-15');
  });

  it('bascule automatiquement après minuit quand l’application reste ouverte', () => {
    vi.setSystemTime(new Date(2026, 6, 15, 23, 59, 59, 900));
    const { result } = renderHook(() => useCurrentDay());

    act(() => vi.advanceTimersByTime(99));
    expect(result.current).toBe('2026-07-15');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('2026-07-16');
  });

  it('se resynchronise au focus après une suspension', () => {
    vi.setSystemTime(new Date(2026, 6, 15, 10, 0));
    const { result } = renderHook(() => useCurrentDay());

    vi.setSystemTime(new Date(2026, 6, 17, 8, 0));
    act(() => window.dispatchEvent(new Event('focus')));

    expect(result.current).toBe('2026-07-17');
  });

  it('se resynchronise sur visibilitychange après une suspension', () => {
    vi.setSystemTime(new Date(2026, 6, 15, 10, 0));
    const { result } = renderHook(() => useCurrentDay());

    vi.setSystemTime(new Date(2026, 6, 18, 8, 0));
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(result.current).toBe('2026-07-18');
  });
});
