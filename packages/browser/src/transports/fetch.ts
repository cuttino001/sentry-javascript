import { eventToSentryRequest } from '@sentry/core';
import { Event, Response, Status } from '@sentry/types';
import { logger, parseRetryAfterHeader, supportsReferrerPolicy, SyncPromise } from '@sentry/utils';
// import axios from 'axios';

import { BaseTransport } from './base';

// const global = getGlobalObject<Window>();

/** `fetch` based transport */
export class FetchTransport extends BaseTransport {
  /** Locks transport after receiving 429 response */
  private _disabledUntil: Date = new Date(Date.now());

  /**
   * @inheritDoc
   */
  public sendEvent(event: Event): PromiseLike<Response> {
    if (new Date(Date.now()) < this._disabledUntil) {
      return Promise.reject({
        event,
        reason: `Transport locked till ${this._disabledUntil} due to too many requests.`,
        status: 429,
      });
    }

    const sentryReq = eventToSentryRequest(event, this._api);

    const options: RequestInit = {
      body: sentryReq.body,
      method: 'POST',
      // Despite all stars in the sky saying that Edge supports old draft syntax, aka 'never', 'always', 'origin' and 'default
      // https://caniuse.com/#feat=referrer-policy
      // It doesn't. And it throw exception instead of ignoring this parameter...
      // REF: https://github.com/getsentry/raven-js/issues/1233
      referrerPolicy: (supportsReferrerPolicy() ? 'origin' : '') as ReferrerPolicy,
    };

    if (this.options.fetchParameters !== undefined) {
      Object.assign(options, this.options.fetchParameters);
    }

    if (this.options.headers !== undefined) {
      options.headers = this.options.headers;
    }

    return this._buffer.add(
      new SyncPromise<Response>((resolve, reject) => {
        let xhr = new XMLHttpRequest();
        xhr.responseType = 'json'; // 指定返回类型

        xhr.onload = () => {
          const status = Status.fromHttpCode(xhr.status);
          if (status === Status.Success) {
            resolve({ status });
            return;
          }
          if (status === Status.RateLimit) {
            const now = Date.now();
            /**
             * "The name is case-insensitive."
             * https://developer.mozilla.org/en-US/docs/Web/API/Headers/get
             */
            const retryAfterHeader = xhr.response.headers.get('Retry-After');
            this._disabledUntil = new Date(now + parseRetryAfterHeader(now, retryAfterHeader));
            logger.warn(`Too many requests, backing off till: ${this._disabledUntil}`);
          }
          reject(xhr.response);
        };

        xhr.open('post', sentryReq.url, true);
        xhr.setRequestHeader('Content-type', 'application/json;charset=UTF-8'); // 设置content-type
        console.log('-----', options.body);
        xhr.send(options.body);
      }),
    );
  }
}
