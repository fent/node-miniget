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
const redirectCodes = { 301: true, 302: true, 303: true, 307: true };
const retryCodes = { 429: true, 503: true };

namespace Miniget {
  export interface Options extends RequestOptions {
    maxRedirects?: number;
    maxRetries?: number;
    maxReconnects?: number;
    downPerMb?: boolean | number;
    backoff?: { inc: number; max: number };
    highWaterMark?: number;
    transform?: (parsedUrl: RequestOptions) => RequestOptions;
    acceptEncoding?: { [key: string]: () => Transform };
  }

  export interface Stream extends PassThrough {
    abort: () => void;
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
  downPerMb: false,
  backoff: { inc: 100, max: 10000 },
};
type Callback = (error: Error, message: IncomingMessage, body: string) => void;

function Miniget(url: string, options?: Miniget.Options): Miniget.Stream;
function Miniget(url: string, options: Miniget.Options, callback?: Callback): void;
function Miniget(url: string, callback: Callback): Miniget.Stream;
function Miniget(url: string, options?: Miniget.Options | Callback, callback?: Callback): Miniget.Stream | void {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (!options) {
    options = {};
  }
  const opts: Miniget.Options = Object.assign({}, defaults, options);
  const stream = new PassThrough({ highWaterMark: opts.highWaterMark }) as Miniget.Stream;
  let myreq: ClientRequest | null, mydecoded: Transform | null;
  let aborted = false;
  let redirects = 0;
  let retries = 0;
  let retryTimeout: NodeJS.Timer;
  let reconnects = 0;
  let mb = 1000000;
  let contentLength: number;
  let acceptRanges = false;
  let rangeStart = 0, rangeEnd: number;
  let downloaded = 0;

  // Check if this is a ranged request.
  if (opts.headers && opts.headers.Range) {
    let r = /bytes=(\d+)-(\d+)?/.exec(opts.headers.Range + '');
    if (r) {
      rangeStart = parseInt(r[1], 10);
      rangeEnd = parseInt(r[2], 10);
    }
  } else if (opts.downPerMb) {
    rangeStart = 0;
    rangeEnd = 0;
  }

  // Add `Accept-Encoding` header.
  if (opts.acceptEncoding) {
    opts.headers = Object.assign({
      'Accept-Encoding': Object.keys(opts.acceptEncoding).join(', ')
    }, opts.headers);
  }

  interface RetryOptions {
    statusCode?: number;
    err?: Error;
    retryAfter?: number;
  }
  const doRetry = (retryOptions: RetryOptions = {}): boolean => {
    if (aborted) { return false; }
    // If there is an error when the download has already started,
    // but not finished, try reconnecting.
    if (mydecoded && 0 < downloaded) {
      if (acceptRanges && downloaded < contentLength &&
        reconnects++ < opts.maxReconnects) {
        mydecoded = null;
        retries = 0;
        let inc = opts.backoff.inc;
        let ms = Math.min(inc, opts.backoff.max);
        retryTimeout = setTimeout(doDownload, ms);
        stream.emit('reconnect', reconnects, retryOptions.err);
        return true;
      } else if (opts.downPerMb && (contentLength > rangeEnd)) {
        doDownload()
        return true;
      }
    } else if ((!retryOptions.statusCode ||
      retryOptions.err && retryOptions.err.message === 'ENOTFOUND') &&
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
    if (!doRetry({ err, statusCode })) {
      stream.emit('error', err);
    }
  };

  const doSampleRequest = (callback: Function) => {
    let parsed: RequestOptions = urlParse(url);
    let httpLib = httpLibs[parsed.protocol];
    if (!httpLib) {
        stream.emit('error', Error('Invalid URL: ' + url));
    }
    Object.assign(parsed, opts)
    httpLib.get(parsed, (res) => {callback(res)});
};

  const doDownload = (): void => {
    if (aborted) { return; }
    let parsed: RequestOptions = urlParse(url);
    let httpLib = httpLibs[parsed.protocol];
    if (!httpLib) {
      stream.emit('error', Error('Invalid URL: ' + url));
      return;
    }

    Object.assign(parsed, opts);
    if (acceptRanges && downloaded > 0) {
      if (opts.downPerMb) {
        let end = rangeEnd += typeof opts.downPerMb === 'number' ? mb * opts.downPerMb : mb * 10;
        let start = rangeStart
        parsed.headers = Object.assign({}, parsed.headers, {
            Range: `bytes=${start}-${end}`
        });
        rangeStart = rangeEnd + 1;
    } else {
        let start = downloaded + rangeStart;
        let end = rangeEnd || '';
        parsed.headers = Object.assign({}, parsed.headers, {
            Range: `bytes=${start}-${end}`
        });
    }
    }

    if (opts.transform) {
      parsed = opts.transform(parsed);
      if (parsed.protocol) {
        httpLib = httpLibs[parsed.protocol];
      }
    }

    myreq = httpLib.get(parsed, (res: IncomingMessage) => {
      if (res.statusCode in redirectCodes) {
        if (redirects++ >= opts.maxRedirects) {
          stream.emit('error', Error('Too many redirects'));
        } else {
          url = res.headers.location;
          setTimeout(doDownload, res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) * 1000: 0);
          stream.emit('redirect', url);
        }
        return;

        // Check for rate limiting.
      } else if (res.statusCode in retryCodes) {
        doRetry({ retryAfter: parseInt(res.headers['retry-after'], 10) });
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
      if (!contentLength) {
        if (opts.downPerMb) {
          doSampleRequest((res: IncomingMessage) => {
          contentLength = parseInt(res.headers['content-length'] + '', 10)
          acceptRanges = res.headers['accept-ranges'] === 'bytes' &&
          contentLength > 0 && opts.maxReconnects > 0;
          stream.emit('response', res);
    });
        } else {
          contentLength = parseInt(res.headers['content-length'] + '', 10);
          acceptRanges = res.headers['accept-ranges'] === 'bytes' &&
          contentLength > 0 && opts.maxReconnects > 0;
          stream.emit('response', res);
  }
};
      let decoded = res as unknown as Transform;
      const cleanup = (): void => {
        res.removeListener('data', ondata);
        decoded.removeListener('end', onend);
        decoded.removeListener('error', onerror);
        res.removeListener('error', onerror);
      };
      const ondata = (chunk: Buffer): void => { downloaded += chunk.length; };
      const onend = (): void => {
        cleanup();
        if (!doRetry()) {
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
            decoded = decoded.pipe(fn());
            decoded.on('error', onerror);
          }
        }
      }
        
      res.on('data', ondata);
      decoded.on('end', onend);
      decoded.on('readable', () => {
        let chunk;
        while (null !== (chunk = decoded.read())) stream.write(chunk)
        })
      mydecoded = decoded;
      res.on('error', onerror);
    });
    myreq.on('error', onRequestError);
    stream.emit('request', myreq);
  };

  stream.abort = (): void => {
    aborted = true;
    stream.emit('abort');
    if (myreq) { myreq.abort(); }
    if (mydecoded) { mydecoded.unpipe(stream); }
    clearTimeout(retryTimeout);
  };

  process.nextTick(doDownload);
  if (callback) {
    let body = '', myres: IncomingMessage;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => body += chunk);
    stream.on('response', (res) => myres = res);
    stream.on('end', () => callback(null, myres, body));
    stream.on('error', callback);
  }
  return callback ? null : stream;
}

export = Miniget;
