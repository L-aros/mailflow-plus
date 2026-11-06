import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./ownership.js', () => ({ findOwnedMessage: vi.fn(), findOwnedAccount: vi.fn() }));
vi.mock('./messageBodyStore.js', () => ({ storeFetchedBody: vi.fn() }));
import { findOwnedMessage, findOwnedAccount } from './ownership.js';
import { storeFetchedBody } from './messageBodyStore.js';
import { readApiMessage } from './apiV1Messages.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('bounds a stalled body fetch and never caches its late result', async () => {
  vi.useFakeTimers();
  findOwnedMessage.mockResolvedValue({ id: 'fixture', account_id: 'account', body_html: null, body_text: null, attachments: [] });
  findOwnedAccount.mockResolvedValue({ id: 'account' });
  let finish;
  const engine = { fetchMessageBody: vi.fn(() => new Promise(resolve => { finish = resolve; })) };
  const result = readApiMessage('owner', 'fixture', engine);
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.fetchMessageBody).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(40000);
  expect(await result).toEqual({ unavailable: true });
  finish({ text: 'Late virtual content', attachments: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(storeFetchedBody).not.toHaveBeenCalled();
});
