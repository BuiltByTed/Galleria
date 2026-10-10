import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

interface TestShareLink {
  id: number;
  album: string;
  secret_key: string;
  created_at: string;
  expires_at: string;
  notified: number;
}

type FailureStage = 'lookup' | 'translation' | 'delivery';

let currentLink: TestShareLink;
let failureStage: FailureStage | null = null;
const notifiedLinkIds: number[] = [];
const loggedErrors: unknown[][] = [];

const database = {
  prepare(sql: string) {
    if (sql.includes('SELECT id, album')) {
      return {
        get: () => currentLink,
      };
    }

    if (sql.includes('UPDATE share_links SET notified = 1')) {
      return {
        run: (linkId: number) => {
          notifiedLinkIds.push(linkId);
        },
      };
    }

    throw new Error(`Unexpected SQL in test: ${sql}`);
  },
};

mock.module('../database.js', {
  namedExports: {
    getDatabase: () => database,
  },
});

mock.module('../database-users.js', {
  namedExports: {
    getAllUsers: () => {
      if (failureStage === 'lookup') {
        throw new Error('user lookup failed');
      }

      return [{ id: 7, role: 'admin' }];
    },
  },
});

mock.module('../i18n-backend.js', {
  namedExports: {
    translateNotification: async () => {
      if (failureStage === 'translation') {
        throw new Error('translation failed');
      }

      return 'translated';
    },
  },
});

mock.module('../push-notifications.js', {
  namedExports: {
    sendNotificationToUser: async () => {
      if (failureStage === 'delivery') {
        throw new Error('notification delivery failed');
      }
    },
  },
});

mock.module('../utils/logger.js', {
  namedExports: {
    error: (...args: unknown[]) => {
      loggedErrors.push(args);
    },
    info: () => {},
    warn: () => {},
  },
});

const {
  cancelShareLinkExpiryTimer,
  scheduleNewShareLinkExpiry,
} = await import('./share-link-expiry-tracker.js');

function resetTestState(): void {
  failureStage = null;
  notifiedLinkIds.length = 0;
  loggedErrors.length = 0;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const timeoutAt = Date.now() + 1_000;

  while (!predicate()) {
    if (Date.now() >= timeoutAt) {
      throw new Error(`Timed out waiting for ${description}`);
    }

    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const stage of ['lookup', 'translation', 'delivery'] as const) {
  test(`already-expired timer leaves notified unset when ${stage} fails`, async () => {
    resetTestState();
    failureStage = stage;
    currentLink = {
      id: 100,
      album: 'expired-album',
      secret_key: 'expired-secret',
      created_at: new Date(Date.now() - 2_000).toISOString(),
      expires_at: new Date(Date.now() - 1_000).toISOString(),
      notified: 0,
    };

    scheduleNewShareLinkExpiry(currentLink.id);

    await waitFor(() => loggedErrors.length > 0, `${stage} failure to be handled`);
    assert.deepEqual(notifiedLinkIds, []);
  });
}

for (const stage of ['lookup', 'translation', 'delivery'] as const) {
  test(`scheduled timer leaves notified unset when ${stage} fails`, async () => {
    resetTestState();
    failureStage = stage;
    currentLink = {
      id: 200,
      album: 'scheduled-album',
      secret_key: 'scheduled-secret',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 20).toISOString(),
      notified: 0,
    };

    scheduleNewShareLinkExpiry(currentLink.id);

    await waitFor(() => loggedErrors.length > 0, `${stage} failure to be handled`);
    assert.deepEqual(notifiedLinkIds, []);
    cancelShareLinkExpiryTimer(currentLink.id);
  });
}

test('successful expiry notification marks the link notified', async () => {
  resetTestState();
  currentLink = {
    id: 300,
    album: 'successful-album',
    secret_key: 'successful-secret',
    created_at: new Date(Date.now() - 2_000).toISOString(),
    expires_at: new Date(Date.now() - 1_000).toISOString(),
    notified: 0,
  };

  scheduleNewShareLinkExpiry(currentLink.id);

  await waitFor(() => notifiedLinkIds.length > 0, 'the notified database update');
  assert.deepEqual(notifiedLinkIds, [currentLink.id]);
});
