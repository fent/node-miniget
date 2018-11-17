const http        = require('http');
const https       = require('https');
const urlParse    = require('url').parse;
const PassThrough = require('stream').PassThrough;


const httpLibs = { 'http:': http, 'https:': https };
const redirectCodes = { 301: true, 302: true, 303: true, 307: true };
const defaults = {
  maxRedirects: 2,
  maxRetries: 2,
  maxReconnects: 0,
  backoff: { inc: 100, max: 10000 },
  highWaterMark: null,
  transform: null,
  acceptEncoding: null,
};

/**
* @param {string} url
* @param {!Object} options
* @param {!Function(Error, http.IncomingMessage, string)} callback
* @return {stream.Readable}
*/
module.exports = (url, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (!options) {
    options = {};
  }
  options = Object.assign({}, defaults, options);
  const stream = new PassThrough({ highWaterMark: options.highWaterMark });
  let myreq, myres;
  let aborted = false;
  let redirects = 0;
  let retries = 0;
  let retryTimeout;
  let reconnects = 0;
  let contentLength;
  let acceptRanges = false;
  let rangeStart = 0, rangeEnd;
  let downloaded = 0;

  // Check if this is a ranged request.
  if (options.headers && options.headers.Range) {
    let r = /bytes=(\d+)-(\d+)?/.exec(options.headers.Range);
    if (r) {
      rangeStart = parseInt(r[1], 10);
      rangeEnd = parseInt(r[2], 10);
    }
  }

  // Add `Accept-Encoding` header.
  if (options.acceptEncoding) {
    options.headers = Object.assign({
      'Accept-Encoding': Object.keys(options.acceptEncoding).join(', ')
    }, options.headers);
  }

  const onRequestError = (err, statusCode) => {
    if (!aborted) {
      // If there is an error when the download has already started,
      // but not finished, try reconnecting.
      if (myres && acceptRanges &&
        0 < downloaded && downloaded < contentLength) {
        if (reconnects++ < options.maxReconnects) {
          myres = null;
          retries = 0;
          let ms = Math.min(options.backoff.inc, options.backoff.max);
          retryTimeout = setTimeout(doDownload, ms);
          stream.emit('reconnect', reconnects, err);
          return;
        }
      } else if ((!statusCode || err.message === 'ENOTFOUND') &&
        retries++ < options.maxRetries) {
        let ms = Math.min(retries * options.backoff.inc, options.backoff.max);
        retryTimeout = setTimeout(doDownload, ms);
        stream.emit('retry', retries, err);
        return;
      }
    }
    stream.emit('error', err);
  };

  const doDownload = () => {
    if (aborted) { return; }
    let parsed = urlParse(url);
    let httpLib = httpLibs[parsed.protocol];
    if (!httpLib) {
      stream.emit('error', Error('Invalid URL: ' + url));
      return;
    }

    Object.assign(parsed, options);
    for (let key in defaults) {
      delete parsed[key];
    }
    if (acceptRanges && downloaded > 0) {
      parsed.headers = Object.assign({}, parsed.headers, {
        Range: `bytes=${downloaded + rangeStart}-${rangeEnd || ''}`
      });
    }

    if (options.transform) {
      parsed = options.transform(parsed);
      if (parsed.protocol) {
        httpLib = httpLibs[parsed.protocol];
      }
    }

    myreq = httpLib.get(parsed, (res) => {
      if (redirectCodes[res.statusCode] === true) {
        if (redirects++ >= options.maxRedirects) {
          stream.emit('error', Error('Too many redirects'));
        } else {
          url = res.headers.location;
          stream.emit('redirect', url);
          doDownload();
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
      let decoded = res;
      if (options.acceptEncoding && res.headers['content-encoding']) {
        for (let enc of res.headers['content-encoding'].split(', ').reverse()) {
          let fn = options.acceptEncoding[enc];
          if (fn != null) {
            decoded = decoded.pipe(fn(decoded));
            decoded.on('error', stream.emit.bind(stream, 'error'));
          }
        }
      }
      if (!contentLength) {
        contentLength = parseInt(res.headers['content-length'], 10);
        acceptRanges = res.headers['accept-ranges'] === 'bytes' &&
          contentLength > 0 && options.maxReconnects > 0;
      }
      if (acceptRanges) {
        res.on('data', (chunk) => { downloaded += chunk.length; });
        decoded.on('end', () => {
          if (downloaded === contentLength) {
            stream.end();
          }
        });
      }
      decoded.pipe(stream, { end: !acceptRanges });
      myres = decoded;
      stream.emit('response', res);
      res.on('error', stream.emit.bind(stream, 'error'));
    });
    myreq.on('error', onRequestError);
    stream.emit('request', myreq);
  };

  stream.abort = () => {
    aborted = true;
    stream.emit('abort');
    if (myreq) { myreq.abort(); }
    if (myres) { myres.unpipe(stream); }
    clearTimeout(retryTimeout);
  };

  process.nextTick(doDownload);
  if (callback) {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { body += chunk; });
    stream.on('end', () => { callback(null, myres, body); });
    stream.on('error', callback);
  }
  return callback ? null : stream;
};
