import { BrowserClient } from '@sentry/browser';
import { Hub, makeMain } from '@sentry/hub';
import { JSDOM } from 'jsdom';

import { SpanStatus } from '../../src';
import {
  BrowserTracing,
  BrowserTracingOptions,
  DEFAULT_MAX_TRANSACTION_DURATION_SECONDS,
  getMetaContent,
} from '../../src/browser/browsertracing';
import { defaultRequestInstrumentionOptions } from '../../src/browser/request';
import { defaultRoutingInstrumentation } from '../../src/browser/router';
import { DEFAULT_IDLE_TIMEOUT, IdleTransaction } from '../../src/idletransaction';
import { getActiveTransaction, secToMs } from '../../src/utils';

let mockChangeHistory: ({ to, from }: { to: string; from?: string }) => void = () => undefined;

jest.mock('@sentry/utils', () => {
  const actual = jest.requireActual('@sentry/utils');
  return {
    ...actual,
    addInstrumentationHandler: ({ callback, type }: any): void => {
      if (type === 'history') {
        mockChangeHistory = callback;
      }
    },
  };
});

const { logger } = jest.requireActual('@sentry/utils');
const warnSpy = jest.spyOn(logger, 'warn');

beforeAll(() => {
  const dom = new JSDOM();
  // @ts-ignore need to override global document
  global.document = dom.window.document;
  // @ts-ignore need to override global document
  global.window = dom.window;
  // @ts-ignore need to override global document
  global.location = dom.window.location;
});

describe('BrowserTracing', () => {
  let hub: Hub;
  beforeEach(() => {
    jest.useFakeTimers();
    hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
    makeMain(hub);
    document.head.innerHTML = '';

    warnSpy.mockClear();
  });

  afterEach(() => {
    const activeTransaction = getActiveTransaction();
    if (activeTransaction) {
      // Should unset off of scope.
      activeTransaction.finish();
    }
  });

  function createBrowserTracing(setup?: boolean, _options?: Partial<BrowserTracingOptions>): BrowserTracing {
    const inst = new BrowserTracing(_options);
    if (setup) {
      const processor = () => undefined;
      inst.setupOnce(processor, () => hub);
    }

    return inst;
  }

  // These are important enough to check with a test as incorrect defaults could
  // break a lot of users configurations.
  it('is created with default settings', () => {
    const browserTracing = createBrowserTracing();

    expect(browserTracing.options).toEqual({
      beforeNavigate: expect.any(Function),
      idleTimeout: DEFAULT_IDLE_TIMEOUT,
      markBackgroundTransactions: true,
      maxTransactionDuration: DEFAULT_MAX_TRANSACTION_DURATION_SECONDS,
      routingInstrumentation: defaultRoutingInstrumentation,
      startTransactionOnLocationChange: true,
      startTransactionOnPageLoad: true,
      ...defaultRequestInstrumentionOptions,
    });
  });

  /**
   * All of these tests under `describe('route transaction')` are tested with
   * `browserTracing.options = { routingInstrumentation: customRoutingInstrumentation }`,
   * so that we can show this functionality works independent of the default routing integration.
   */
  describe('route transaction', () => {
    const customRoutingInstrumentation = (startTransaction: (obj: any) => void) => {
      startTransaction({ name: 'a/path', op: 'pageload' });
    };

    it('calls custom routing instrumenation', () => {
      createBrowserTracing(true, {
        routingInstrumentation: customRoutingInstrumentation,
      });

      const transaction = getActiveTransaction(hub) as IdleTransaction;
      expect(transaction).toBeDefined();
      expect(transaction.name).toBe('a/path');
      expect(transaction.op).toBe('pageload');
    });

    it('trims all transactions', () => {
      createBrowserTracing(true, {
        routingInstrumentation: customRoutingInstrumentation,
      });

      const transaction = getActiveTransaction(hub) as IdleTransaction;
      const span = transaction.startChild();
      span.finish();

      if (span.endTimestamp) {
        transaction.finish(span.endTimestamp + 12345);
      }
      expect(transaction.endTimestamp).toBe(span.endTimestamp);
    });

    describe('tracingOrigins', () => {
      it('warns and uses default tracing origins if non are provided', () => {
        const inst = createBrowserTracing(true, {
          routingInstrumentation: customRoutingInstrumentation,
        });

        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(inst.options.tracingOrigins).toEqual(defaultRequestInstrumentionOptions.tracingOrigins);
      });

      it('warns and uses default tracing origins if empty array given', () => {
        const inst = createBrowserTracing(true, {
          routingInstrumentation: customRoutingInstrumentation,
          tracingOrigins: [],
        });

        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(inst.options.tracingOrigins).toEqual(defaultRequestInstrumentionOptions.tracingOrigins);
      });

      it('warns and uses default tracing origins if tracing origins are not defined', () => {
        const inst = createBrowserTracing(true, {
          routingInstrumentation: customRoutingInstrumentation,
          tracingOrigins: undefined,
        });

        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(inst.options.tracingOrigins).toEqual(defaultRequestInstrumentionOptions.tracingOrigins);
      });

      it('sets tracing origins if provided and does not warn', () => {
        const inst = createBrowserTracing(true, {
          routingInstrumentation: customRoutingInstrumentation,
          tracingOrigins: ['something'],
        });

        expect(warnSpy).toHaveBeenCalledTimes(0);
        expect(inst.options.tracingOrigins).toEqual(['something']);
      });
    });

    describe('beforeNavigate', () => {
      it('is called on transaction creation', () => {
        const mockBeforeNavigation = jest.fn().mockReturnValue({ name: 'here/is/my/path' });
        createBrowserTracing(true, {
          beforeNavigate: mockBeforeNavigation,
          routingInstrumentation: customRoutingInstrumentation,
        });
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction).toBeDefined();

        expect(mockBeforeNavigation).toHaveBeenCalledTimes(1);
      });

      it('does not create a transaction if it returns undefined', () => {
        const mockBeforeNavigation = jest.fn().mockReturnValue(undefined);
        createBrowserTracing(true, {
          beforeNavigate: mockBeforeNavigation,
          routingInstrumentation: customRoutingInstrumentation,
        });
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction).not.toBeDefined();

        expect(mockBeforeNavigation).toHaveBeenCalledTimes(1);
      });

      it('can override default context values', () => {
        const mockBeforeNavigation = jest.fn(ctx => ({
          ...ctx,
          op: 'not-pageload',
        }));
        createBrowserTracing(true, {
          beforeNavigate: mockBeforeNavigation,
          routingInstrumentation: customRoutingInstrumentation,
        });
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction).toBeDefined();
        expect(transaction.op).toBe('not-pageload');

        expect(mockBeforeNavigation).toHaveBeenCalledTimes(1);
      });
    });

    it('sets transaction context from sentry-trace header', () => {
      const name = 'sentry-trace';
      const content = '126de09502ae4e0fb26c6967190756a4-b6e54397b12a2a0f-1';
      document.head.innerHTML = `<meta name="${name}" content="${content}">`;
      createBrowserTracing(true, { routingInstrumentation: customRoutingInstrumentation });
      const transaction = getActiveTransaction(hub) as IdleTransaction;

      expect(transaction.traceId).toBe('126de09502ae4e0fb26c6967190756a4');
      expect(transaction.parentSpanId).toBe('b6e54397b12a2a0f');
      expect(transaction.sampled).toBe(true);
    });

    describe('idleTimeout', () => {
      it('is created by default', () => {
        createBrowserTracing(true, { routingInstrumentation: customRoutingInstrumentation });
        const mockFinish = jest.fn();
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        transaction.finish = mockFinish;

        const span = transaction.startChild(); // activities = 1
        span.finish(); // activities = 0

        expect(mockFinish).toHaveBeenCalledTimes(0);
        jest.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT);
        expect(mockFinish).toHaveBeenCalledTimes(1);
      });

      it('can be a custom value', () => {
        createBrowserTracing(true, { idleTimeout: 2000, routingInstrumentation: customRoutingInstrumentation });
        const mockFinish = jest.fn();
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        transaction.finish = mockFinish;

        const span = transaction.startChild(); // activities = 1
        span.finish(); // activities = 0

        expect(mockFinish).toHaveBeenCalledTimes(0);
        jest.advanceTimersByTime(2000);
        expect(mockFinish).toHaveBeenCalledTimes(1);
      });
    });

    describe('maxTransactionDuration', () => {
      it('cancels a transaction if exceeded', () => {
        createBrowserTracing(true, { routingInstrumentation: customRoutingInstrumentation });
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        transaction.finish(transaction.startTimestamp + secToMs(DEFAULT_MAX_TRANSACTION_DURATION_SECONDS) + 1);

        expect(transaction.status).toBe(SpanStatus.DeadlineExceeded);
        expect(transaction.tags.maxTransactionDurationExceeded).toBeDefined();
      });

      it('does not cancel a transaction if not exceeded', () => {
        createBrowserTracing(true, { routingInstrumentation: customRoutingInstrumentation });
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        transaction.finish(transaction.startTimestamp + secToMs(DEFAULT_MAX_TRANSACTION_DURATION_SECONDS));

        expect(transaction.status).toBe(undefined);
        expect(transaction.tags.maxTransactionDurationExceeded).not.toBeDefined();
      });

      it('can have a custom value', () => {
        const customMaxTransactionDuration = 700;
        // Test to make sure default duration is less than tested custom value.
        expect(DEFAULT_MAX_TRANSACTION_DURATION_SECONDS < customMaxTransactionDuration).toBe(true);
        createBrowserTracing(true, {
          maxTransactionDuration: customMaxTransactionDuration,
          routingInstrumentation: customRoutingInstrumentation,
        });
        const transaction = getActiveTransaction(hub) as IdleTransaction;

        transaction.finish(transaction.startTimestamp + secToMs(customMaxTransactionDuration));

        expect(transaction.status).toBe(undefined);
        expect(transaction.tags.maxTransactionDurationExceeded).not.toBeDefined();
      });
    });
  });

  // Integration tests for the default routing instrumentation
  describe('default routing instrumentation', () => {
    describe('pageload transaction', () => {
      it('is created on setup on scope', () => {
        createBrowserTracing(true);
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction).toBeDefined();

        expect(transaction.op).toBe('pageload');
      });

      it('is not created if the option is false', () => {
        createBrowserTracing(true, { startTransactionOnPageLoad: false });
        const transaction = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction).not.toBeDefined();
      });
    });

    describe('navigation transaction', () => {
      beforeEach(() => {
        mockChangeHistory = () => undefined;
      });

      it('it is not created automatically at startup', () => {
        createBrowserTracing(true);
        jest.runAllTimers();

        const transaction = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction).not.toBeDefined();
      });

      it('is created on location change', () => {
        createBrowserTracing(true);
        const transaction1 = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction1.op).toBe('pageload');
        expect(transaction1.endTimestamp).not.toBeDefined();

        mockChangeHistory({ to: 'here', from: 'there' });
        const transaction2 = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction2.op).toBe('navigation');

        expect(transaction1.endTimestamp).toBeDefined();
      });

      it('is not created if startTransactionOnLocationChange is false', () => {
        createBrowserTracing(true, { startTransactionOnLocationChange: false });
        const transaction1 = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction1.op).toBe('pageload');
        expect(transaction1.endTimestamp).not.toBeDefined();

        mockChangeHistory({ to: 'here', from: 'there' });
        const transaction2 = getActiveTransaction(hub) as IdleTransaction;
        expect(transaction2.op).toBe('pageload');
      });
    });
  });
});

describe('getMeta', () => {
  it('returns a found meta tag contents', () => {
    const name = 'sentry-trace';
    const content = '126de09502ae4e0fb26c6967190756a4-b6e54397b12a2a0f-1';
    document.head.innerHTML = `<meta name="${name}" content="${content}">`;

    const meta = getMetaContent(name);
    expect(meta).toBe(content);
  });

  it('only returns meta tags queried for', () => {
    document.head.innerHTML = `<meta name="not-test">`;

    const meta = getMetaContent('test');
    expect(meta).toBe(null);
  });
});
