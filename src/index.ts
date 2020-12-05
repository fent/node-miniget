import { RequestOptions, IncomingMessage, ClientRequest, default as http } from 'http';
import { EventEmitter } from 'events';
import https from 'https';
import { parse as urlParse } from 'url';
import { PassThrough, Transform } from 'stream';


const httpLibs: {
  [key: string]: {
    request: (options: RequestOptions | string | URL, callback?: (res: IncomingMessage) => void) => ClientRequest;
  };
} = { 'http:': http, 'https:': https };
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);
const retryStatusCodes = new Set([429, 503]);

// `request`, `response`, `abort`, left out, miniget will emit these.
const requestEvents = ['connect', 'continue', 'information', 'socket', 'timeout', 'upgrade'];
const responseEvents = ['aborted'];

namespace Miniget {
  export interface Options extends RequestOptions {
    maxRedirects?: number;
    maxRetries?: number;
    maxReconnects?: number;
    backoff?: { inc: number; max: number };
    highWaterMark?: number;
    transform?: (parsedUrl: RequestOptions) => RequestOptions;
    acceptEncoding?: { [key: string]: () => Transform };
  }

  export interface DefaultOptions extends Options {
    maxRedirects: number;
    maxRetries: number;
    maxReconnects: number;
    backoff: { inc: number; max: number };
  }

  export type defaultOptions = Miniget.Options;
  export type MinigetError = Error;

  export interface Stream extends PassThrough {
    abort: (err?: Error) => void;
    aborted: boolean;
    destroy: (err?: Error) => void;
    destroyed: boolean;
    text: () => Promise<string>;
    on(event: 'reconnect', listener: (attempt: number, err?: Miniget.MinigetError) => void): this;
    on(event: 'retry', listener: (attempt: number, err?: Miniget.MinigetError) => void): this;
    on(event: 'redirect', listener: (url: string) => void): this;
    on(event: string | symbol, listener: (...args: any) => void): this;
  }
}

Miniget.MinigetError = class MinigetError extends Error {
  public statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
};

Miniget.defaultOptions = {
  maxRedirects: 10,
  maxRetries: 2,
  maxReconnects: 0,
  backoff: { inc: 100, max: 10000 },
};

function Miniget(url: string, options: Miniget.Options = {}): Miniget.Stream {
  const opts: Miniget.DefaultOptions = Object.assign({}, Miniget.defaultOptions, options);
  const stream = new PassThrough({ highWaterMark: opts.highWaterMark }) as Miniget.Stream;
  stream.destroyed = stream.aborted = false;
  let activeRequest: ClientRequest | null;
  let activeResponse: IncomingMessage | null;
  let activeDecodedStream: Transform | null;
  let redirects = 0;
  let retries = 0;
  let retryTimeout: NodeJS.Timer;
  let reconnects = 0;
  let contentLength: number;
  let acceptRanges = false;
  let rangeStart = 0, rangeEnd: number;
  let downloaded = 0;

  // Check if this is a ranged request.
  if (opts.headers?.Range) {
    let r = /bytes=(\d+)-(\d+)?/.exec(`${opts.headers.Range}`);
    if (r) {
      rangeStart = parseInt(r[1], 10);
      rangeEnd = parseInt(r[2], 10);
    }
  }

  // Add `Accept-Encoding` header.
  if (opts.acceptEncoding) {
    opts.headers = Object.assign({
      'Accept-Encoding': Object.keys(opts.acceptEncoding).join(', '),
    }, opts.headers);
  }

  const downloadHasStarted = () => activeDecodedStream && downloaded > 0;
  const downloadComplete = () => !acceptRanges || downloaded === contentLength;

  const reconnect = (err?: Miniget.MinigetError) => {
    activeDecodedStream = null;
    retries = 0;
    let inc = opts.backoff.inc;
    let ms = Math.min(inc, opts.backoff.max);
    retryTimeout = setTimeout(doDownload, ms);
    stream.emit('reconnect', reconnects, err);
  };

  const reconnectIfEndedEarly = (err?: Miniget.MinigetError) => {
    if (options.method !== 'HEAD' && !downloadComplete() && reconnects++ < opts.maxReconnects) {
      reconnect(err);
      return true;
    }
    return false;
  };

  interface RetryOptions {
    statusCode?: number;
    err?: Miniget.MinigetError;
    retryAfter?: number;
  }
  const retryRequest = (retryOptions: RetryOptions): boolean => {
    if (stream.destroyed) { return false; }
    if (downloadHasStarted()) {
      return reconnectIfEndedEarly(retryOptions.err);
    } else if (
      (!retryOptions.statusCode || retryOptions.err.message === 'ENOTFOUND') &&
      retries++ < opts.maxRetries) {
      let ms = retryOptions.retryAfter ||
        Math.min(retries * opts.backoff.inc, opts.backoff.max);
      retryTimeout = setTimeout(doDownload, ms);
      stream.emit('retry', retries, retryOptions.err);
      return true;
    }
    return false;
  };

  const forwardEvents = (ee: EventEmitter, events: string[]) => {
    for (let event of events) {
      ee.on(event, stream.emit.bind(stream, event));
    }
  };

  const doDownload = () => {
    let parsed: RequestOptions = {}, httpLib;
    try {
      parsed = urlParse(url);
      httpLib = httpLibs[parsed.protocol];
    } catch (err) {
      // Let the error be caught by the if statement below.
    }
    if (!httpLib) {
      stream.emit('error', new Miniget.MinigetError(`Invalid URL: ${url}`));
      return;
    }

    Object.assign(parsed, opts);
    if (acceptRanges && downloaded > 0) {
      let start = downloaded + rangeStart;
      let end = rangeEnd || '';
      parsed.headers = Object.assign({}, parsed.headers, {
        Range: `bytes=${start}-${end}`,
      });
    }

    if (opts.transform) {
      try {
        parsed = opts.transform(parsed);
      } catch (err) {
        stream.emit('error', err);
        return;
      }
      if (!parsed || parsed.protocol) {
        httpLib = httpLibs[parsed?.protocol];
        if (!httpLib) {
          stream.emit('error', new Miniget.MinigetError('Invalid URL object from `transform` function'));
          return;
        }
      }
    }

    const onError = (err: Miniget.MinigetError, statusCode?: number): void => {
      cleanup();
      if (!retryRequest({ err, statusCode })) {
        stream.emit('error', err);
      } else {
        activeRequest.removeListener('close', onRequestClose);
      }
    };

    const onRequestClose = () => {
      cleanup();
      retryRequest({});
    };

    const cleanup = () => {
      activeRequest.removeListener('error', onError);
      activeRequest.removeListener('close', onRequestClose);
      activeResponse?.removeListener('data', onData);
      activeDecodedStream?.removeListener('end', onEnd);
      activeDecodedStream?.removeListener('error', onError);
      activeResponse?.removeListener('error', onError);
    };

    const onData = (chunk: Buffer) => { downloaded += chunk.length; };

    const onEnd = () => {
      cleanup();
      if (!reconnectIfEndedEarly()) {
        stream.end();
      }
    };

    activeRequest = httpLib.request(parsed, (res: IncomingMessage) => {
      // Needed for node v10, v12.
      // istanbul ignore next
      if (stream.destroyed) { return; }
      if (redirectStatusCodes.has(res.statusCode as number)) {
        if (redirects++ >= opts.maxRedirects) {
          stream.emit('error', new Miniget.MinigetError('Too many redirects'));
        } else {
          if (res.headers.location) {
            url = res.headers.location;
          } else {
            let err = new Miniget.MinigetError('Redirect status code given with no location', res.statusCode);
            stream.emit('error', err);
            cleanup();
            return;
          }
          setTimeout(doDownload, res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) * 1000 : 0);
          stream.emit('redirect', url);
        }
        cleanup();
        return;

        // Check for rate limiting.
      } else if (retryStatusCodes.has(res.statusCode as number)) {
        if (!retryRequest({ retryAfter: parseInt(res.headers['retry-after'], 10) })) {
          let err = new Miniget.MinigetError(`Status code: ${res.statusCode}`, res.statusCode);
          stream.emit('error', err);
        }
        cleanup();
        return;
      } else if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 400)) {
        let err = new Miniget.MinigetError(`Status code: ${res.statusCode}`, res.statusCode);
        if (res.statusCode >= 500) {
          onError(err, res.statusCode);
        } else {
          stream.emit('error', err);
        }
        cleanup();
        return;
      }

      activeDecodedStream = res as unknown as Transform;
      if (opts.acceptEncoding && res.headers['content-encoding']) {
        for (let enc of res.headers['content-encoding'].split(', ').reverse()) {
          let fn = opts.acceptEncoding[enc];
          if (fn) {
            activeDecodedStream = activeDecodedStream.pipe(fn());
            activeDecodedStream.on('error', onError);
          }
        }
      }
      if (!contentLength) {
        contentLength = parseInt(`${res.headers['content-length']}`, 10);
        acceptRanges = res.headers['accept-ranges'] === 'bytes' &&
          contentLength > 0 && opts.maxReconnects > 0;
      }
      res.on('data', onData);
      activeDecodedStream.on('end', onEnd);
      activeDecodedStream.pipe(stream, { end: !acceptRanges });
      activeResponse = res;
      stream.emit('response', res);
      res.on('error', onError);
      forwardEvents(res, responseEvents);
    });
    activeRequest.on('error', onError);
    activeRequest.on('close', onRequestClose);
    forwardEvents(activeRequest, requestEvents);
    if (stream.destroyed) {
      streamDestroy(...destroyArgs);
    }
    stream.emit('request', activeRequest);
    activeRequest.end();
  };

  stream.abort = (err?: Error) => {
    console.warn('`MinigetStream#abort()` has been deprecated in favor of `MinigetStream#destroy()`');
    stream.aborted = true;
    stream.emit('abort');
    stream.destroy(err);
  };

  let destroyArgs: any[];
  const streamDestroy = (err?: Error) => {
    activeRequest.destroy(err);
    activeDecodedStream?.unpipe(stream);
    activeDecodedStream?.destroy();
    clearTimeout(retryTimeout);
  };

  stream._destroy = (...args: any[]) => {
    stream.destroyed = true;
    if (activeRequest) {
      streamDestroy(...args);
    } else {
      destroyArgs = args;
    }
  };

  stream.text = () => new Promise((resolve, reject) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => body += chunk);
    stream.on('end', () => resolve(body));
    stream.on('error', reject);
  });

  process.nextTick(doDownload);
  return stream;
}

export = Miniget;
