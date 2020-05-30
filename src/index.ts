import { RequestOptions, IncomingMessage, ClientRequest } from 'http';
import http from 'http';
import https from 'https';
import { parse as urlParse } from 'url';
import { PassThrough, Transform } from 'stream';


const httpLibs: {
  [key: string]: {
    get: (options: RequestOptions | string | URL, callback?: (res: IncomingMessage) => void) => ClientRequest;
  };
} = { 'http:': http, 'https:': https };
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);
const retryStatusCodes = new Set([429, 503]);

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

  export interface Stream extends PassThrough {
    abort: () => void;
    text: () => Promise<string>;
    on(event: 'reconnect', listener: (attempt: number, err?: Error) => void): this;
    on(event: 'retry', listener: (attempt: number, err?: Error) => void): this;
    on(event: 'redirect', listener: (url: string) => void): this;
    on(event: string | symbol, listener: (...args: any) => void): this;
  }
}

const defaults: Miniget.Options = {
  maxRedirects: 2,
  maxRetries: 2,
  maxReconnects: 0,
  backoff: { inc: 100, max: 10000 },
};

function Miniget(url: string, options: Miniget.Options = {}): Miniget.Stream {
  const opts: Miniget.Options = Object.assign({}, defaults, options);
  const stream = new PassThrough({ highWaterMark: opts.highWaterMark }) as Miniget.Stream;
  let activeRequest: ClientRequest | null;
  let activeDecodedStream: Transform | null;
  let aborted = false;
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
    let r = /bytes=(\d+)-(\d+)?/.exec(opts.headers.Range + '');
    if (r) {
      rangeStart = parseInt(r[1], 10);
      rangeEnd = parseInt(r[2], 10);
    }
  }

  // Add `Accept-Encoding` header.
  if (opts.acceptEncoding) {
    opts.headers = Object.assign({
      'Accept-Encoding': Object.keys(opts.acceptEncoding).join(', ')
    }, opts.headers);
  }

  const downloadHasStarted = () => activeDecodedStream && 0 < downloaded;
  const downloadEnded = () => !acceptRanges || downloaded == contentLength;

  const reconnect = (err?: Error) => {
    activeDecodedStream = null;
    retries = 0;
    let inc = opts.backoff.inc;
    let ms = Math.min(inc, opts.backoff.max);
    retryTimeout = setTimeout(doDownload, ms);
    stream.emit('reconnect', reconnects, err);
  };

  const reconnectIfEndedEarly = (err?: Error) => {
    if (!downloadEnded() && reconnects++ < opts.maxReconnects) {
      reconnect(err);
      return true;
    }
    return false;
  };

  interface RetryOptions {
    statusCode?: number;
    err?: Error;
    retryAfter?: number;
  }
  const retryRequest = (retryOptions: RetryOptions): boolean => {
    if (aborted) { return false; }
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

  const onRequestError = (err: Error, statusCode?: number): void => {
    if (!retryRequest({ err, statusCode })) {
      stream.emit('error', err);
    }
  };

  const doDownload = (): void => {
    if (aborted) { return; }
    let parsed: RequestOptions, httpLib;
    try {
      parsed = urlParse(url);
      httpLib = httpLibs[parsed.protocol];
    } catch (err) {
      // Let the error be caught by the if statement below.
    }
    if (!httpLib) {
      stream.emit('error', Error('Invalid URL: ' + url));
      return;
    }

    Object.assign(parsed, opts);
    if (acceptRanges && downloaded > 0) {
      let start = downloaded + rangeStart;
      let end = rangeEnd || '';
      parsed.headers = Object.assign({}, parsed.headers, {
        Range: `bytes=${start}-${end}`
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
          stream.emit('error', Error('Invalid URL object from `transform` function'));
          return;
        }
      }
    }

    activeRequest = httpLib.get(parsed, (res: IncomingMessage) => {
      if (redirectStatusCodes.has(res.statusCode)) {
        if (redirects++ >= opts.maxRedirects) {
          stream.emit('error', Error('Too many redirects'));
        } else {
          url = res.headers.location;
          setTimeout(doDownload, res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) * 1000: 0);
          stream.emit('redirect', url);
        }
        return;

        // Check for rate limiting.
      } else if (retryStatusCodes.has(res.statusCode)) {
        if (!retryRequest({ retryAfter: parseInt(res.headers['retry-after'], 10) })) {
          let err = Error('Status code: ' + res.statusCode);
          stream.emit('error', err);
        }
        return;
      } else if (res.statusCode < 200 || 400 <= res.statusCode) {
        let err = Error('Status code: ' + res.statusCode);
        if (res.statusCode >= 500) {
          onRequestError(err, res.statusCode);
        } else {
          stream.emit('error', err);
        }
        return;
      }
      let decodedStream = res as unknown as Transform;
      const cleanup = (): void => {
        res.removeListener('data', ondata);
        decodedStream.removeListener('end', onend);
        decodedStream.removeListener('error', onerror);
        res.removeListener('error', onerror);
      };
      const ondata = (chunk: Buffer): void => { downloaded += chunk.length; };
      const onend = (): void => {
        cleanup();
        if (!reconnectIfEndedEarly()) {
          stream.end();
        }
      };
      const onerror = (err: Error): void => {
        cleanup();
        onRequestError(err);
      };

      if (opts.acceptEncoding && res.headers['content-encoding']) {
        for (let enc of res.headers['content-encoding'].split(', ').reverse()) {
          let fn = opts.acceptEncoding[enc];
          if (fn != null) {
            decodedStream = decodedStream.pipe(fn());
            decodedStream.on('error', onerror);
          }
        }
      }
      if (!contentLength) {
        contentLength = parseInt(res.headers['content-length'] + '', 10);
        acceptRanges = res.headers['accept-ranges'] === 'bytes' &&
          contentLength > 0 && opts.maxReconnects > 0;
      }
      res.on('data', ondata);
      decodedStream.on('end', onend);
      decodedStream.pipe(stream, { end: !acceptRanges });
      activeDecodedStream = decodedStream;
      stream.emit('response', res);
      res.on('error', onerror);
    });
    activeRequest.on('error', onRequestError);
    stream.emit('request', activeRequest);
  };

  stream.abort = (): void => {
    aborted = true;
    stream.emit('abort');
    activeRequest?.abort();
    activeDecodedStream?.unpipe(stream);
    clearTimeout(retryTimeout);
  };

  stream.text = async () => new Promise((resolve, reject) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => body += chunk);
    stream.on('end', () => resolve(body));
    stream.on('error', reject);
  });

  process.nextTick(doDownload);
  return stream;
}

export = Miniget;
